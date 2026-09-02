/**
 * php-cs-fixer ancestor config carriage (#2472).
 *
 * `php-cs-fixer`'s own `ConfigurationResolver` does NOT walk up parent
 * directories looking for a config file — verified against
 * `computeConfigFiles()` in `PHP-CS-Fixer/PHP-CS-Fixer` at tag `v3.64.0`
 * (`src/Console/ConfigurationResolver.php`): its candidate list is built
 * from `$configDir` (derived from an explicit `--path`) or else
 * `$this->cwd` — the process's own working directory — only:
 *
 *   $candidates = [
 *       $configDir.\DIRECTORY_SEPARATOR.'.php-cs-fixer.php',
 *       $configDir.\DIRECTORY_SEPARATOR.'.php-cs-fixer.dist.php',
 *       $configDir.\DIRECTORY_SEPARATOR.'.php_cs',       // legacy v2
 *       $configDir.\DIRECTORY_SEPARATOR.'.php_cs.dist',  // legacy v2
 *   ];
 *
 * Unlike prettier/biome/eslint, an ancestor config found by `detect()`'s own
 * climb (`hasPhpCsFixerConfig` in `clients/tool-policy.ts`,
 * `phpCsFixerFormatter.detect` in `clients/formatters.ts`) is invisible to a
 * bare `php-cs-fixer fix <file>` invocation whenever `formatFile`'s spawn cwd
 * (the FILE's own directory) is not the exact directory the config lives in
 * — php-cs-fixer silently falls back to its built-in default ruleset
 * instead of the project's configured one.
 *
 * `computeConfigFiles()`'s own candidate order also settles same-directory
 * precedence: `.php-cs-fixer.php` wins over `.php-cs-fixer.dist.php` when
 * both sit in the SAME directory (first match in the array wins). This
 * resolver mirrors that precedence; the two legacy v2 names are not one of
 * pi-lens's detection targets (`hasPhpCsFixerConfig`/
 * `phpCsFixerFormatter.detect` never look for them either) so they are not
 * candidates here.
 *
 * Reuses the shared `findNearestMarkerRoot` walker (`clients/path-utils.ts`,
 * home-ceiling guarded via `isAtOrAboveHomeDir`, `homeDir`-injectable for
 * tests) instead of a private walker — the same primitive
 * `resolveCargoPackageEdition` (#2466) and `resolveKtfmtGradleStyle` (#2468)
 * climb with for their own manifest-value-into-argv carriage.
 */
import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findNearestMarkerRoot } from "./path-utils.js";

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
	const configDir = findNearestMarkerRoot(
		startDir,
		PHP_CS_FIXER_CONFIG_NAMES,
		{ homeDir },
	);
	if (!configDir) return undefined;
	for (const name of PHP_CS_FIXER_CONFIG_NAMES) {
		const candidate = path.join(configDir, name);
		if (existsSync(candidate)) return candidate;
	}
	// Unreachable: findNearestMarkerRoot only returns a directory that
	// contains at least one of these markers.
	return undefined;
}
