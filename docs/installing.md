# Installing @lilypad-studio/libs

The library is internal: it is published to the npm registry of GitHub Packages, under the `Lilypad-Studio` organization. Only the people and the repositories given access to the package can install it, and every install needs a token, even a read-only one.

## 1. Point the scope to GitHub Packages

Commit this `.npmrc` at the root of the application. It holds no secret: it only says where the `@lilypad-studio` packages come from.

```ini
@lilypad-studio:registry=https://npm.pkg.github.com
```

Then install the package (and `postgres` if the application uses `@lilypad-studio/libs/db`):

```bash
npm install @lilypad-studio/libs
```

## 2. Give npm a token

The token is never committed. Where it comes from depends on where `npm install` runs.

### On a workstation

Create a **personal access token (classic)** with the `read:packages` scope (GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)). GitHub Packages does not accept fine-grained tokens for npm. If the organization uses SAML single sign-on, authorize the token for it (`Configure SSO` next to the token).

Then log in once. npm stores the token in your user `~/.npmrc`, not in the project:

```bash
npm login --scope=@lilypad-studio --auth-type=legacy --registry=https://npm.pkg.github.com
# Username: your GitHub username. Password: the token.
```

### In GitHub Actions

Use the token of the workflow: no secret to create.

1. Once, in the settings of the package (Lilypad-Studio → Packages → libs → Package settings → **Manage Actions access**), add the repository of the application with the `Read` role.
2. In its workflow:

```yaml
permissions:
  contents: read
  packages: read
steps:
  - uses: actions/setup-node@v7
    with:
      node-version: 24
      registry-url: https://npm.pkg.github.com
      scope: '@lilypad-studio'
  - run: npm ci
    env:
      NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### On Vercel (or any other build service)

Create a classic token with `read:packages` only, ideally for a machine account that can read the package and nothing else. Store the whole `.npmrc` in an environment variable: Vercel writes the `NPM_RC` variable to the `.npmrc` of the build.

```ini
# Value of NPM_RC (Project Settings → Environment Variables)
@lilypad-studio:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=ghp_...
```

On other services, set an environment variable (e.g. `NODE_AUTH_TOKEN`) and add the token line to the `.npmrc` of the build step only: `//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}` (npm reads `${...}` from the environment, and fails if the variable is missing, which is why this line does not belong in the committed `.npmrc`).

### In a Docker image

Pass the `.npmrc` as a build secret, so that the token stays out of the layers:

```dockerfile
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
```

```bash
docker build --secret id=npmrc,src=$HOME/.npmrc .
```

## Upgrading from `@lilypad/libs` (installed from git)

Up to 0.6.0 the package was `@lilypad/libs`, installed with `npm install github:Lilypad-Studio/LilypadLibs`. From 0.7.0:

1. Do steps 1 and 2 above.
2. `npm uninstall @lilypad/libs && npm install @lilypad-studio/libs`.
3. Replace `@lilypad/libs` with `@lilypad-studio/libs` in the imports and in the config files (`lilypad.config.ts`).

To keep the old imports instead, install the new package under the old name: `npm install @lilypad/libs@npm:@lilypad-studio/libs`.

The other breaking changes of 0.7.0 are listed in [CHANGELOG.md](../CHANGELOG.md).
