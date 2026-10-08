# Making a change

Keep a pull request small enough that its behavior and evidence can be reviewed together.

## Before editing

1. Read the decision log for the subsystem.
2. Find the current phase and its non-goals.
3. Search every caller of shared code you plan to change.
4. Identify the public contract: manifest, plugin API, wire protocol, CLI, or workspace format.

Start a discussion before adding a dependency, public API, manifest field, event type, architecture change, or new product behavior.

## Implement the complete slice

- Preserve the core dependency boundary.
- Keep secrets out of manifests and command arguments.
- Give every new error a corrective `hint`.
- Add a focused test for non-trivial core behavior.
- Update the relevant binding specification in the same pull request.
- Update examples and public documentation when a user journey changes.

Do not hide a validation or runtime failure and exit successfully. A precise refusal is preferable to partial behavior the caller cannot detect.

## Verify and report

Run the narrowest test while iterating, then the affected repository checks. In the pull request, state what changed, why it belongs in this phase, the commands you ran, and any check you could not run.

Do not include unrelated formatting, generated files from another task, or local agent data. Maintainers prepare the version and release.
