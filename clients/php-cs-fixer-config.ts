/**
 * php-cs-fixer ancestor config carriage (#2472).
 *
 * `php-cs-fixer`'s own `ConfigurationResolver` does NOT walk up parent
 * directories looking for a config file — verified against
 * `computeConfigFiles()` in `PHP-CS-Fixer/PHP-CS-Fixer` at tag `v3.64.0`
 * (commit `58dd9c931c785a79739310aef5178928305ffa67`,
 * `src/Console/ConfigurationResolver.php:548-588`). There is no `--path`
 * OPTION on `fix` — `path` is a positional `InputArgument` (the file(s) to
 * format; `--path-mode` only changes how an EXPLICIT `--config`'s own
 * `finder()` intersects with it, per `FixCommand.php:206-207`), and the
 * candidate directory is driven by that positional argument's dirname, not
 * by `$this->cwd` — cwd is only a SECOND, ADDITIONAL probe appended when it
 * differs from the path's directory:
 *
 *   $path = $this->getPath();
 *
 *   if ($this->isStdIn() || 0 === \count($path)) {
 *       $configDir = $this->cwd;
 *   } elseif (1 < \count($path)) {
 *       throw new InvalidConfigurationException('For multiple paths config parameter is required.');
 *   } elseif (!is_file($path[0])) {
 *       $configDir = $path[0];
 *   } else {
 *       $dirName = pathinfo($path[0], PATHINFO_DIRNAME);
 *       $configDir = is_dir($dirName) ? $dirName : $path[0];
 *   }
 *
 *   $candidates = [
 *       $configDir.\DIRECTORY_SEPARATOR.'.php-cs-fixer.php',
 *       $configDir.\DIRECTORY_SEPARATOR.'.php-cs-fixer.dist.php',
 *       $configDir.\DIRECTORY_SEPARATOR.'.php_cs', // old v2 config, present here only to throw nice error message later
 *       $configDir.\DIRECTORY_SEPARATOR.'.php_cs.dist', // old v2 config, present here only to throw nice error message later
 *   ];
 *
 *   if ($configDir !== $this->cwd) {
 *       $candidates[] = $this->cwd.\DIRECTORY_SEPARATOR.'.php-cs-fixer.php';
 *       $candidates[] = $this->cwd.\DIRECTORY_SEPARATOR.'.php-cs-fixer.dist.php';
 *       $candidates[] = $this->cwd.\DIRECTORY_SEPARATOR.'.php_cs'; // old v2 config, present here only to throw nice error message later
 *       $candidates[] = $this->cwd.\DIRECTORY_SEPARATOR.'.php_cs.dist'; // old v2 config, present here only to throw nice error message later
 *   }
 *
 *   return $candidates;
 *
 * We always spawn `fix` with the FILE as a positional argument (not stdin,
 * never a bare directory), so `$path[0]` is always that file and `$configDir`
 * always resolves to `pathinfo($path[0], PATHINFO_DIRNAME)` — the file's OWN
 * directory — REGARDLESS of the spawned process's cwd. This means the
 * alternative fix of just spawning with `cwd = <ancestor config's directory>`
 * would NOT work: php-cs-fixer never consults its own process cwd to build
 * `$configDir` once a file argument is present, only the (unrelated) `$this
 * ->cwd`-equality check for whether to ALSO probe cwd as a second candidate.
 * Explicit `--config <path>` is the only carriage that reaches an ancestor
 * config; there is no spawn-option workaround.
 *
 * Unlike prettier/biome/eslint, an ancestor config found by `detect()`'s own
 * climb (`hasPhpCsFixerConfig` in `clients/tool-policy.ts`,
 * `phpCsFixerFormatter.detect` in `clients/formatters.ts`) is invisible to a
 * bare `php-cs-fixer fix <file>` invocation whenever that ancestor directory
 * is neither the file's own directory nor the spawn's cwd — php-cs-fixer
 * silently falls back to its built-in default ruleset instead of the
 * project's configured one.
 *
 * `computeConfigFiles()`'s own candidate order also settles same-directory
 * precedence: `.php-cs-fixer.php` wins over `.php-cs-fixer.dist.php` when
 * both sit in the SAME directory (first match in the array wins). This
 * resolver mirrors that precedence; the two legacy v2 names are not one of
 * pi-lens's detection targets (`hasPhpCsFixerConfig`/
 * `phpCsFixerFormatter.detect` never look for them either) so they are not
 * candidates here.
 *
 * Reuses the shared `findLocalToolConfig` walker (`clients/path-utils.ts`,
 * home-ceiling guarded via `isAtOrAboveHomeDir`, `homeDir`-injectable for
 * tests) — the same single source of truth `opengrep-config.ts`,
 * `sgconfig.ts`, `typos-config.ts`, and `zizmor-config.ts` already delegate
 * to for their own "walk up for one of these config filenames" search
 * (refs #680, #2472 review F2), rather than a private walker of its own.
 */
import * as os from "node:os";
import * as path from "node:path";
import { findLocalToolConfig } from "./path-utils.js";

/**
 * In `computeConfigFiles()`'s own precedence order — `.php-cs-fixer.php`
 * before `.php-cs-fixer.dist.php` — so a same-directory precedence check can
 * just take the first existing name.
 */
export const PHP_CS_FIXER_CONFIG_NAMES = [
	".php-cs-fixer.php",
	".php-cs-fixer.dist.php",
] as const;

/**
 * Resolve the nearest ancestor php-cs-fixer config FILE for `filePath`
 * (climbing from the file's own directory, never the file itself), or
 * `undefined` when none is found before the home-directory ceiling.
 */
export function resolvePhpCsFixerConfig(
	filePath: string,
	homeDir: string = os.homedir(),
): string | undefined {
	const startDir = path.dirname(path.resolve(filePath));
	return findLocalToolConfig(startDir, PHP_CS_FIXER_CONFIG_NAMES, { homeDir });
}
