import * as fs from 'fs';
import * as path from 'path';

/**
 * The artifact the backend deploys must be reproducible from the source in this repo.
 *
 * An independent reviewer installed the root workspace from `package.json` alone and got
 * **solc 0.8.36** against a `^0.8.24` range. The logic bytecode matched after stripping
 * metadata, but the full artifacts were not byte-identical -- which is enough to make
 * "does the committed artifact correspond to this source?" unanswerable, and that is the
 * exact question the 2026-08-04 incident turned on. A stale hand-kept copy deployed the
 * old ETH-only splitter, and its fees are stranded forever.
 *
 * Two things close it: an exact compiler pin, and the compiler version recorded IN the
 * artifact so a mismatch is visible without recompiling.
 */
describe('contract artifacts are reproducible', () => {
  const root = path.join(__dirname, '../..');
  const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  it('pins solc exactly, with no range', () => {
    // A caret range means the compiler is whatever npm resolved on the day someone
    // installed. Two machines then produce two artifacts from one source, and neither
    // is wrong.
    const solc = String(rootPkg.dependencies?.solc ?? '');
    expect(solc).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('the installed compiler is the pinned one', () => {
    const installed = JSON.parse(
      fs.readFileSync(path.join(root, 'node_modules/solc/package.json'), 'utf8')
    ).version;
    expect(installed).toBe(rootPkg.dependencies.solc);
  });

  it('records the compiler version inside the artifact', () => {
    // So a mismatch is visible by reading the file, without a rebuild. The artifact used
    // to carry only { abi, bytecode } -- nothing said what produced it.
    const artifact = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../src/feeSplitterArtifact.json'), 'utf8')
    );
    expect(artifact._compiler).toBeTruthy();
    expect(artifact._compiler.solc).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('the artifact was built by the pinned compiler', () => {
    const artifact = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../src/feeSplitterArtifact.json'), 'utf8')
    );
    expect(artifact._compiler.solc).toBe(rootPkg.dependencies.solc);
  });

  it('the root workspace has a committed lockfile', () => {
    // Without one, `npm install` at the root resolves the whole toolchain afresh --
    // hardhat, ethers, solc -- and the artifacts it produces are a function of the day.
    expect(fs.existsSync(path.join(root, 'package-lock.json'))).toBe(true);
  });
});
