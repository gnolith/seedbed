# Security policy

Report vulnerabilities privately through the GitHub security advisory form for
`gnolith/seedbed`. Do not include secrets, databases, backups, or private paths in
public issues.

Seedbed 0.4 supports Node.js 24. It accepts no secret bytes in CLI arguments or
project configuration, creates local bearer files exclusively in protected user
state, validates immutable artifact/image digests, binds host publication to
loopback, and runs migration/restore/adoption only as explicit digest-bound offline
operations.
