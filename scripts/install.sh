#!/bin/sh
# Install the standalone build from a GitHub release.
#
#   curl -fsSL https://github.com/moeen-mahmud/dispach/releases/latest/download/install.sh | sh
#
# Puts the release in ~/.dispach/versions/<version>, links ~/.dispach/bin/dispach at it, and adds
# ~/.dispach/bin to PATH in your shell's rc file (it says which). Nothing needs root.
#
#   DISPACH_VERSION=0.2.2        a specific release instead of the latest
#   DISPACH_NO_MODIFY_PATH=1     leave every rc file alone
#   DISPACH_INSTALL_DIR=<dir>    install somewhere other than ~/.dispach
#   DISPACH_DOWNLOAD_BASE=<url>  fetch the archive and SHA256SUMS from a mirror (or a test build)
#
# Uninstall: rm -rf ~/.dispach/bin ~/.dispach/versions, and delete the PATH line it added.
# Your agents and conversations live beside them in ~/.dispach and are not touched either way.

set -eu

slug=dispach
repo=moeen-mahmud/dispach
version=${DISPACH_VERSION:-latest}
root=${DISPACH_INSTALL_DIR:-$HOME/.$slug}

say() { printf '%s\n' "$*"; }
fail() {
    printf 'error: %s\n' "$1" >&2
    if [ -n "${2:-}" ]; then printf '  hint: %s\n' "$2" >&2; fi
    exit 1
}

# ── which build ───────────────────────────────────────────────────────────────────────────────
case $(uname -s) in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW* | MSYS* | CYGWIN*)
        fail "native Windows is not supported yet" \
            "run this inside WSL (wsl --install), or use the container: docker run ghcr.io/$repo"
        ;;
    *) fail "no standalone build for $(uname -s)" "npm i -g $slug (needs Node 24), or the container image" ;;
esac
case $(uname -m) in
    arm64 | aarch64) arch=arm64 ;;
    x86_64 | amd64) arch=x64 ;;
    *) fail "no standalone build for $(uname -m)" "npm i -g $slug (needs Node 24), or the container image" ;;
esac
# A shell under Rosetta reports x86_64 on Apple silicon; the native build is the right one.
if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = 1 ]; then
    arch=arm64
fi
# Node's official Linux builds link glibc, so they do not start on musl (Alpine).
if [ "$os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
    fail "this looks like a musl system (Alpine); the standalone build needs glibc" \
        "use the container image, or npm i -g $slug with Alpine's own nodejs package"
fi

asset=$slug-$os-$arch.tar.gz
if [ -n "${DISPACH_DOWNLOAD_BASE:-}" ]; then
    base=$DISPACH_DOWNLOAD_BASE
elif [ "$version" = latest ]; then
    base=https://github.com/$repo/releases/latest/download
else
    base=https://github.com/$repo/releases/download/v${version#v}
fi

if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q -O "$2" "$1"; }
else
    fail "neither curl nor wget is installed" "install one of them and run this again"
fi
if command -v sha256sum >/dev/null 2>&1; then
    digest() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
    digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
    fail "neither sha256sum nor shasum is installed" "the download cannot be checked without one"
fi

# ── download and check ────────────────────────────────────────────────────────────────────────
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset ($version)"
fetch "$base/$asset" "$tmp/$asset" ||
    fail "could not download $base/$asset" "check the version exists: https://github.com/$repo/releases"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "could not download $base/SHA256SUMS"
expected=$(awk -v f="$asset" '$2 == f { print $1 }' "$tmp/SHA256SUMS")
[ -n "$expected" ] || fail "SHA256SUMS does not list $asset"
actual=$(digest "$tmp/$asset")
[ "$actual" = "$expected" ] ||
    fail "$asset failed its checksum (got $actual, expected $expected)" "nothing was installed; try again"

tar -xzf "$tmp/$asset" -C "$tmp"
unpacked=$tmp/$slug-$os-$arch
installed=$(cat "$unpacked/VERSION")

# ── install ───────────────────────────────────────────────────────────────────────────────────
mkdir -p "$root/versions" "$root/bin"
dest=$root/versions/$installed
link=$root/bin/$slug
previous=$(readlink "$link" 2>/dev/null || true)
rm -rf "$dest"
mv "$unpacked" "$dest"
# Swapped by rename, so a shell running the command mid-install sees the old one or the new one.
ln -s "$dest/bin/$slug" "$link.new"
mv -f "$link.new" "$link"
"$link" --version >/dev/null || fail "installed $installed, but it does not start" "run $link --version to see why"

# A service unit names the version directory it was installed from, so that one stays, and so does
# the version this replaced, which a running process may still load files from. Others go.
units="$HOME/Library/LaunchAgents/$slug.server.plist ${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$slug.server.service"
service_on=""
for unit in $units; do
    if [ -f "$unit" ]; then
        service_on=$(grep -o "$root/versions/[^/]*" "$unit" | head -n 1 || true)
        if [ -n "$service_on" ]; then break; fi
    fi
done
for old in "$root"/versions/*; do
    [ -d "$old" ] || continue
    case $old in
        "$dest" | "$service_on") continue ;;
    esac
    case $previous in "$old"/*) continue ;; esac
    rm -rf "$old"
done

say "installed $slug $installed to $dest"
if [ -n "$service_on" ] && [ "$service_on" != "$dest" ]; then
    say "your background server still runs ${service_on##*/}; move it to $installed with: $slug daemon install"
fi

# ── PATH ──────────────────────────────────────────────────────────────────────────────────────
case ":$PATH:" in
    *":$root/bin:"*) exit 0 ;;
esac
if [ "${DISPACH_NO_MODIFY_PATH:-}" = 1 ]; then
    say "add $root/bin to your PATH to run $slug (DISPACH_NO_MODIFY_PATH is set, so no rc file was changed)"
    exit 0
fi
case $(basename "${SHELL:-sh}") in
    zsh) rc=${ZDOTDIR:-$HOME}/.zshrc line="export PATH=\"$root/bin:\$PATH\"" ;;
    bash)
        if [ "$os" = darwin ]; then rc=$HOME/.bash_profile; else rc=$HOME/.bashrc; fi
        line="export PATH=\"$root/bin:\$PATH\""
        ;;
    fish)
        rc=${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/$slug.fish
        line="fish_add_path \"$root/bin\""
        mkdir -p "$(dirname "$rc")"
        ;;
    *) rc=$HOME/.profile line="export PATH=\"$root/bin:\$PATH\"" ;;
esac
if ! grep -qsF "$line" "$rc"; then
    printf '\n# added by the %s installer\n%s\n' "$slug" "$line" >>"$rc"
    say "added $root/bin to PATH in $rc"
fi
say "open a new terminal, or run: $line"
