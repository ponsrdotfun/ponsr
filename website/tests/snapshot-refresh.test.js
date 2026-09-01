/**
 * THE SCHEDULED REFRESH KEEPS THE SITE'S FLOOR OFF THE FLOOR.
 *
 * `website/data/launches.json` is where every page, the board and every social
 * card start; the live functions only advance past it. Nothing refreshed it, so
 * the gap to the chain head grew daily until the scan that closes it stopped
 * completing. Measured on production with the snapshot two days old: discovery
 * covered 1 547 782 blocks, the launch feed took 25.5 s, returned `partial`,
 * and a token that plainly exists dropped out of the list -- every card for it
 * answered 503. After the refresh the same feed answered in 0.48 s.
 *
 * These pin the parts of that job that are easy to break later and expensive to
 * notice: what it publishes, and what it checks before publishing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const workflow = () => read('.github/workflows/refresh-snapshot.yml');

test('the refresh runs on a schedule and can also be run by hand', () => {
  const yml = workflow();
  assert.match(yml, /^\s*schedule:/m, 'the refresh is not scheduled');
  assert.match(yml, /cron: '[^']+'/, 'no cron expression');
  assert.match(yml, /^\s*workflow_dispatch:/m, 'it cannot be run by hand after a launch');
  // Two refreshes racing would push conflicting snapshots.
  assert.match(yml, /concurrency:/);
});

test('it publishes the snapshot and nothing else', () => {
  const yml = workflow();
  // Netlify's build command regenerates the token pages and the social cards
  // from the snapshot, so committing them here would add nothing -- and would
  // re-encode every card PNG on a runner whose image library differs from the
  // one that wrote them.
  assert.match(yml, /git add website\/data\/launches\.json/);
  assert.doesNotMatch(yml, /git add -A|git add \.\s|git add website\/social/);
  assert.match(read('netlify.toml'), /command = "npm run build:website"/);
});

test('nothing is pushed until the snapshot contract passes', () => {
  const yml = workflow();
  const check = yml.indexOf('node website/smoke-test.js');
  const push = yml.indexOf('git push');
  assert.ok(check > 0, 'the snapshot contract is never checked');
  assert.ok(push > 0, 'nothing is published');
  assert.ok(check < push, 'the contract is checked after publishing, which is too late');
});

test('a quiet day does not publish, and a new launch does', () => {
  const script = read('scripts/refresh-snapshot.mjs');
  // Every refresh advances asOfBlock, so writing unconditionally would publish
  // the site several times a day to say nothing new.
  assert.match(script, /--stale-after=/);
  assert.match(script, /STALE_AFTER > 0 && !appeared && gap < STALE_AFTER/);
  // `appeared` is what makes a new launch bypass the threshold -- that is the
  // case where a token is waiting for its page.
  assert.match(script, /const appeared = refreshed\.launches\.length !== existing\.launches\.length;/);
  assert.match(workflow(), /--stale-after=/);
});

/**
 * A SHORT SCAN MUST BANK ITS PROGRESS AND SAY WHERE IT STOPPED.
 *
 * This asserted that an unreadable range refuses the whole run. The hazard it
 * named is real — writing a half-finished read is how a launch vanishes from the
 * floor — but the refusal was the wrong remedy, and on 2026-09-02 it cost a real
 * user. Their launch was FOUND at 95.3% of the scan and thrown away, because the
 * last 4 465 blocks would not read; the site went on showing three launches while
 * a stranger's token sat on chain unlisted. Third ratchet of this shape here.
 *
 * The hazard only exists because `asOfBlock` is a claim of coverage that every
 * future run starts from. Bank what was read and write the block it was read
 * THROUGH, and the unread tail is just next run's window — which is what an
 * incremental scan has always been. So what is pinned now is the honesty of the
 * coverage figure, not the discarding of work.
 */
/**
 * THE ACCUMULATOR MUST NOT BE SHADOWED, AND THIS ONE WAITED FOR A STRANGER.
 *
 * `const observed = []` collects the refreshed launches at module scope. Inside
 * the per-launch loop, the curve-activity read was ALSO called `observed`, so
 * `observed.push(...)` at the end of that loop reached the activity object
 * rather than the array.
 *
 * It could not fire on the three committed launches, which are carried forward
 * unchanged without entering that path. It fired on the first genuinely new
 * launch this repository ever processed — a real user's, on 2026-09-02 — and
 * killed the refresh with `observed.push is not a function`.
 *
 * The quieter half is worse and is what this test really guards. Renaming only
 * the declaration leaves `observed.state === 'complete'` reading `undefined` off
 * an array: no crash, no message, and curve activity silently never recorded
 * again. A shadow that throws is lucky; a shadow that merely answers wrongly is
 * the one that ships.
 */
test('the launch accumulator is declared once and never shadowed', () => {
  const script = read('scripts/refresh-snapshot.mjs');
  const declarations = script.match(/\b(?:const|let|var)\s+observed\s*=/g) ?? [];
  assert.equal(
    declarations.length,
    1,
    `"observed" is declared ${declarations.length} times; an inner one shadows the accumulator`
  );
});

test('a short scan banks what it read and never claims the head it did not reach', () => {
  const script = read('scripts/refresh-snapshot.mjs');

  // The scan reports coverage rather than a bare list, and the exhausted branch
  // returns it instead of killing the run.
  assert.match(script, /return \{ logs, coveredThrough: cursor - 1 \}/, 'an unreadable range must bank its progress');
  assert.match(script, /return \{ logs, coveredThrough: toBlock \}/, 'a complete scan must report full coverage');

  // The published figures come from what was READ, never from the head.
  assert.match(script, /asOfBlock: coveredThrough/, 'asOfBlock must not claim the head');
  assert.match(script, /throughBlock: coveredThrough/, 'the source must not overstate its own window');
  assert.doesNotMatch(script, /asOfBlock: head/);

  // And coverage may never move backwards, or a failed first chunk would
  // un-claim ground the snapshot already holds and re-scan it forever.
  assert.match(script, /coveredThrough = Math\.max\(/, 'coverage must never regress');

  // refuse() still exists for the failures that are NOT a short read -- an
  // identity the chain disagrees with is still fatal, and still aborts before
  // anything is written.
  assert.match(script, /function refuse\(/);
  assert.match(script, /process\.exit\(1\)/);
  assert.match(script, /is not what the chain reports/);
  const write = script.indexOf('await fs.writeFile(SNAPSHOT');
  assert.ok(write > script.lastIndexOf('refuse(`'), 'a refusal can be followed by a write');
});

/**
 * A WINDOW SCAN MUST NEVER DELETE A LAUNCH IT SIMPLY DID NOT LOOK AT.
 *
 * The refresh swept from the deployment's first block to the head on every run
 * -- 24 million blocks by 2026-09-01 -- and refuses to write a partial scan.
 * Correct on its own, and together a ratchet: the scheduled run failed three
 * times in a row on a range near block 28623096 that could not be read even at
 * 12 500 blocks after eight attempts, and it would have failed forever, because
 * that range sits behind every future run and the window only grows.
 *
 * Scanning forward from `asOfBlock` fixes it and introduces the one bug that
 * would be worse than a stale snapshot: building the launch list from what the
 * window saw would delete every launch older than the window. That is the exact
 * outcome the partial-scan refusal exists to prevent, arriving through the front
 * door. These assertions are on the merge, not on the scan.
 */
test('the window carries forward what it did not scan, and never rebuilds from scratch', () => {
  const source = read('scripts/refresh-snapshot.mjs');

  // The default start is the snapshot's own reach, not the deployment's first block.
  assert.match(source, /const scanFrom = FROM_GENESIS[\s\S]{0,200}Number\(existing\.asOfBlock/);
  assert.match(source, /REORG_OVERLAP/, 'a reorg near the tip must be re-read');
  assert.match(source, /--from-genesis/, 'a full sweep must remain available');

  // The published list is a MERGE over the committed one. If this ever becomes
  // `const launches = observed`, every launch outside the window is deleted.
  const merge = source.slice(source.indexOf('const seen = new Set('), source.indexOf('const gate = await fetchPublicGate('));
  assert.match(merge, /new Map\(existing\.launches\.map/);
  assert.match(merge, /for \(const launch of observed\) merged\.set/);
  assert.match(merge, /const launches = \[\.\.\.merged\.values\(\)\]/);
  assert.doesNotMatch(source, /^const launches = observed;?$/m);

  // The source record must state the window it actually read. A source that
  // overstates its own coverage is worse than one that admits a window.
  assert.match(source, /fromBlock: FROM_GENESIS \? DEPLOYMENT\.startBlock : scanFrom/);
});
