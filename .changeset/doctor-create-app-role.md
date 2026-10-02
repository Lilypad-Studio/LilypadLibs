---
'@lilypad-studio/libs': minor
---

#### Added

- `lilypad-doctor` creates the role of the application. Set `appRole` in the config (`defineLilypadDb`, `@lilypad-studio/libs/schema`) to a role that does not exist yet, and run `lilypad-doctor --sql` with the owner's URL: the fix of `missing-app-role` creates it (without a password, since the migrations are committed: set it with `ALTER ROLE app_user PASSWORD '...'` or the console of your provider), with its `statement_timeout` and only what the tables of the config need: `USAGE` on their schemas, `SELECT` of their described columns, the writes of `LilypadDbCache` (`INSERT` and `UPDATE` of the described columns, `DELETE`, `USAGE` on the sequence of a serial generated key), and `SELECT` on the changelog of the `changelog` strategy. Then connect the application as it; when the config gains a table or a column, `missing-privilege` reports the `GRANT` it needs.

  ```ts
  export default defineLilypadDb({ appRole: 'app_user', tables: { users, plans } });
  ```

- `access` option of a table (`defineLilypadTable`, `@lilypad-studio/libs/schema`): `'read'` when the application only reads the table. The role the doctor creates gets no write of it, and the doctor no longer reports the writes it lacks. Defaults to `'write'`. Type `LilypadDbTableAccess`.
- With `strict: true`, `lilypad-doctor` warns when the role of the application has more privileges than the tables need (`privileged-app-role`): a superuser, `CREATEROLE`, `BYPASSRLS`, or the privileges of the owner of a cached table or of the changelog. `checkLilypadSchema` (`@lilypad-studio/libs/db`) takes it as its `strict` option.
