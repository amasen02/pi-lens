---
section: Fixed
---

- **Install**: the published `package.json` no longer carries `devDependencies` (stripped by `prepack`, restored by `postpack`). npm's resolver walked the dev peer graph when pi supplies host-provided packages into the installed extension, and `@vitejs/devtools@0.7.1` / `vitest@5.0.0` (published 2026-09-03) crash npm 10.9.8 there (`Cannot read properties of null (reading 'edgesOut')`); every install-test lane went red and npm-10 users would hit it at install. The published package never needed them.
