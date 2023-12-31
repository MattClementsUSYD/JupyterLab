#!/usr/bin/env node
/* -----------------------------------------------------------------------------
| Copyright (c) Jupyter Development Team.
| Distributed under the terms of the Modified BSD License.
|----------------------------------------------------------------------------*/

import { structUtils } from '@yarnpkg/core';
import { parseSyml, stringifySyml } from '@yarnpkg/parsers';
import { program } from 'commander';
import fs from 'fs';
import micromatch from 'micromatch';
import semver from 'semver';
import { exitOnUncaughtException, run } from './utils';

/**
 * Yarn lock entry
 *
 * Copied from https://github.com/christophehurpeau/yarn-deduplicate/blob/yarn-berry/src/yarnlock.ts
 */
type YarnEntry = {
  version: string;
  resolution: string;
  dependencies?: Record<string, string>;
  checksum?: string;
  languageName?: 'node';
  linkType?: 'hard' | 'soft';
};

// Copied from https://github.com/yarnpkg/berry/blob/d85702c61e3b19715c728fa9d2ecec68dcbf39b2/packages/yarnpkg-core/sources/Project.ts#L1988
const yarnLockHeader = `${[
  `# This file is generated by running "yarn install" inside your project.\n`,
  `# Manual changes might be lost - proceed with caution!\n`
].join(``)}\n`;

export function upgradeLock(
  packages: string,
  options: { lock: string; cwd?: string }
): void {
  exitOnUncaughtException();

  const lockFile = options.lock ?? 'yarn.lock';

  // Load current yarn.lock
  const pkgs = loadPackages(lockFile);
  const pkgToDescriptor = new Map<string, string[]>();
  for (const pkg in pkgs) {
    if (pkg.startsWith('__')) {
      continue;
    }
    const name = extractNameFromDescriptor(pkgs[pkg].resolution);

    if (pkgToDescriptor.has(name)) {
      pkgToDescriptor.get(name)!.push(pkg);
    } else {
      pkgToDescriptor.set(name, [pkg]);
    }
  }

  // Update the yarn.lock file recursevily at most 5 times (normally twice is enough)
  let counter = 5;
  do {
    run('jlpm install', { cwd: options.cwd });
  } while (
    upgradeSelectedPackages(lockFile, pkgToDescriptor, packages, pkgs) &&
    counter-- > 0
  );

  // Check that the yarn.lock is immutable
  run('jlpm install --immutable', { cwd: options.cwd });
}

/**
 * Downgrade package versions to match old locked version expect
 * for the package matching the provided pattern.
 *
 * @param lockFile yarn.lock file
 * @param pkgToDescriptor Package name to yarn descriptors
 * @param packages Package pattern to update
 * @param pkgs Original package versions
 * @returns Whether some versions have been downgraded or not
 */
function upgradeSelectedPackages(
  lockFile: string,
  pkgToDescriptor: Map<string, string[]>,
  packages: string,
  pkgs: Record<string, YarnEntry>
): boolean {
  let hasChange = false;
  const newPkgs = loadPackages(lockFile);
  for (const pkg in newPkgs) {
    if (pkg.startsWith('__')) {
      continue;
    }
    const name = extractNameFromDescriptor(newPkgs[pkg].resolution);
    if (pkgToDescriptor.has(name)) {
      if (!micromatch.isMatch(name, packages)) {
        let noMatch = true;
        for (const origDescriptor of pkgToDescriptor.get(name)!) {
          const origPkg = pkgs[origDescriptor];
          if (
            pkg.split(',').every(desc => {
              const parsedDesc = structUtils.parseDescriptor(desc.trim());
              const range = structUtils.parseRange(parsedDesc.range);
              return (
                !semver.validRange(range.selector) ||
                semver.satisfies(origPkg.version, range.selector)
              );
            })
          ) {
            noMatch = false;
            if (origPkg.version !== newPkgs[pkg].version) {
              hasChange = true;
              console.log(
                `Downgrade '${name}' from ${newPkgs[pkg].version} to ${origPkg.version}`
              );
              newPkgs[pkg] = origPkg;
            }
            break;
          }
        }
        if (noMatch) {
          console.warn(`No package found for '${pkg}'.`);
        }
      } else {
        console.log(`Ignoring package '${pkg}'.`);
      }
    } else {
      console.warn(`New package '${pkg}' added.`);
    }
  }

  if (hasChange) {
    const newLock = yarnLockHeader + stringifySyml(newPkgs);

    fs.writeFileSync(lockFile, newLock, { encoding: 'utf-8' });
  }
  return hasChange;
}

function extractNameFromDescriptor(name: string): string {
  const descriptor = structUtils.parseDescriptor(name.split(',')[0].trim());
  return descriptor.scope
    ? `@${descriptor.scope}/${descriptor.name}`
    : descriptor.name;
}

function loadPackages(lockFile: string): Record<string, YarnEntry> {
  const yarnLock = fs.readFileSync(lockFile, { encoding: 'utf-8' });
  return parseSyml(yarnLock);
}

if (require.main === module) {
  program
    .description(
      'Update yarn.lock at minima; aka only packages matching the provided pattern (support fnmatch syntax) are updated.'
    )
    .option('--lock', 'yarn.lock file name', 'yarn.lock')
    .arguments('packages')
    .action(upgradeLock);
  program.parse(process.argv);
}
