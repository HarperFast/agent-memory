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
  the new password and re-reads role and row. A user an admin changed mid-request (promoted, deactivated) gets a
  fresh unreturned password and `user_changed`. A competing rotation's password is left alone.
- **No orphaned users.** `issue` commits the reservation (row, and a delegate's `actsFor` row) under the name's
  record lock (`getLockScope()`) before `add_user`. A crash after `add_user` leaves a managed user its owner can
  rotate. A crash before leaves a reservation that a retry takes over after `RESERVATION_TTL_MS`. A 409 from
  `add_user` releases only a reservation still carrying this request's `createdAt`. Nothing deletes a user, which
  could delete one an admin made under the same name.
- **A new user inherits no grants.** `grantRowReusable` refuses a leftover `user:<name>` row with grants, or with an
  `actsFor` other than the delegate's own principal. `hasInboundDelegation` refuses a principal name that some user
  still acts for.
- **A delegation group never mixes clearance.** A delegate shares `user:<principal>`, and private memories are never
  content-checked (`src/quarantine.ts` `decideContentFlag`). So addDelegate sets `actsFor` only on a delegate of the
  principal's own role; one of another role (an `eng` person's `eng-public` machine) is a standalone user, tied to the
  person only by its `ProvisionedUser` row. `provision-user.sh --acts-for` refuses `eng-public` paired with another
  role.
- **`<principal>.<machine>` is a machine user's name.** `refuseDelegateShapedName` stops a principal from reading as a
  delegate of an existing user. The row's `machine` says which a managed user is.
- **No secret leaves in a log.** Failures log a stage, the cause's name and status, and a `ref` (`StageFailure`),
  never the cause's text, which may echo credentials. Harper's operation log already drops `password`.
