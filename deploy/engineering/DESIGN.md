# Engineering deployment — design

Invariants of this app's own code that the code cannot state. Operating it: [README.md](README.md).

## Self-serve provisioning (`provision.js`)

`Provision` issues Harper credentials. Harper's permission model cannot limit which role `add_user` assigns, so a
role allowed to call it could mint a `super_user`. The provisioner role therefore holds no operations, and the
resource calls `server.operation` with authorization off, after its own checks.

- **Only the provisioner calls it.** Every method starts with `authorizeCaller`: role `provisioner` or
  `super_user`, by role name.
- **It touches only users it made, in roles it may assign.** `ASSIGNABLE_ROLES` is the whole set it assigns.
  `requireManaged` gates rotate and addDelegate: the user has a `ProvisionedUser` row, is active and holds an
  assignable role. The row, not the role, is the test, because admin-made engineers already hold `eng` under email
  usernames. An admin adopts a user by writing its row.
- **A credential is returned only while it authenticates the intended user.** `confirmIssued` authenticates with
  the new password and re-reads role and row. For a user an admin changed mid-request (promoted, deactivated), or
  whose password a competing request replaced, it answers `user_changed` and drops the password; nobody else ever
  held it, so nothing more is written.
- **No orphaned users, and no grant before its user.** `issue` reserves (the `ProvisionedUser` row) under the name's
  record lock (`getLockScope()`), then runs `add_user`, then writes a delegate's `actsFor` row under the principal's
  lock after re-reading the principal's role. A crash after `add_user` leaves a managed user its owner can rotate,
  at worst without `actsFor`, which grants less. A crash before leaves a reservation that a retry takes over after
  `RESERVATION_TTL_MS`. A failed `add_user` releases a fresh reservation still carrying this request's `createdAt`
  when the failure is a 409 or no user exists; one it took over stays, since the earlier request may yet create, or
  already created, its user. Nothing deletes a user, which could delete one an admin made under the same name.
  Left open, as admin-side (below): a crash before `add_user` followed by an admin creating that name leaves the
  admin's user managed, and a rotate writes by username, so it can overwrite an admin's concurrent reset.
- **Machine users are admitted under the principal's lock.** addDelegate locks the principal and the machine name,
  re-reads the principal's role there, and counts machine users that exist or are still being created
  (`countMachines`) against `MAX_DELEGATES`, so concurrent requests cannot exceed it or act on a stale role.
- **A new user inherits no grants.** `grantRowEmpty` refuses a leftover `user:<name>` row with grants or an
  `actsFor`, which would apply the moment the user exists. `hasInboundDelegation` refuses a name that some user
  still acts for.
- **A delegation group never mixes clearance.** A delegate shares `user:<principal>`, and private memories are never
  content-checked (`src/quarantine.ts` `decideContentFlag`). So addDelegate sets `actsFor` only on a delegate of the
  principal's own role; one of another role (an `eng` person's `eng-public` machine) is a standalone user, tied to the
  person only by its `ProvisionedUser` row. `provision-user.sh --acts-for` refuses a pair whose roles differ in
  customer clearance (`clearance`). A later admin role change is outside both; README says how to handle it.
- **The threat is the caller, not the admin.** The checks above assume the provisioner credential may be
  compromised or Dispatch buggy: whatever it sends, no role but `eng`/`eng-public` is assigned, no user the flow
  did not create is touched, no password for another role is obtained, and concurrent requests make neither two
  users nor a mixed delegation group. Admins are trusted and rare, so their changes get no fencing. An admin who
  changes a managed user's role, drops it or recreates its name updates or deletes its `ProvisionedUser` row, and
  one who changes a person's role clears `actsFor` on that person's machine users whose role now differs.
  `refuseMixedGroup` is the backstop: rotate and addDelegate refuse (`mixed_delegation`) in a group left mixed.
- **`<principal>.<machine>` is a machine user's name.** `refuseDelegateShapedName` stops a principal from reading as a
  delegate of an existing user. The row's `machine` says which a managed user is.
- **No secret leaves in a log.** Failures log a stage, the cause's name and status, and a `ref` (`StageFailure`),
  never the cause's text, which may echo credentials. Harper's operation log already drops `password`.
