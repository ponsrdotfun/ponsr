/**
 * A COLLECT BUTTON MAY ONLY APPEAR OVER FEES THAT ARE ACTUALLY THE READER'S.
 *
 * The three launches on record make this concrete, and they are not symmetric:
 * PONSR STONKS was the canary, so its splitter's `creator()` is the TREASURY.
 * Microduck and NOBI were launched by the owner, so theirs is the owner's Privy
 * wallet. A signed-in owner must therefore be offered two controls, not three --
 * and a rule that merely checked "is somebody signed in" would offer all three
 * and let the server say no.
 *
 * The addresses below were read from the deployed splitters, not invented.
 *
 * These tests drive the decision itself rather than the markup around it. A test
 * that searched the painter's source for a class name would pass just as happily
 * while the gate compared a constant to itself -- which is precisely how this
 * repository's `rpcPool` admitted a wrong-chain endpoint with every test green.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
const OWNER = '0xcdce6c82d995d3223d4e956a3c28d36bad875dc0';

const signedIn = (address) => ({ state: 'authenticated', wallet: { address } });
const held = (accruedWei) => ({ state: 'observed', accruedWei });

test('a control is offered only for the launches whose splitter pays the reader', async () => {
  const { claimableBy } = await import('../assets/claim.mjs');
  const asset = held('20520000000000000');

  assert.equal(claimableBy({ creator: OWNER }, asset, signedIn(OWNER)), true);
  // Same reader, the canary's splitter: it pays the treasury, so nothing is offered.
  assert.equal(claimableBy({ creator: TREASURY }, asset, signedIn(OWNER)), false);
  // Case must not decide the answer: chain reads come back lowercase, sessions
  // come back checksummed, and they are the same wallet.
  assert.equal(claimableBy({ creator: OWNER.toUpperCase().replace('0X', '0x') }, asset, signedIn(OWNER)), true);
});

test('a reader who is not signed in is never offered a control', async () => {
  const { claimableBy } = await import('../assets/claim.mjs');
  const asset = held('20520000000000000');

  assert.equal(claimableBy({ creator: OWNER }, asset, { state: 'unauthenticated' }), false);
  assert.equal(claimableBy({ creator: OWNER }, asset, undefined), false);
  // The case that actually tests the session check rather than the address one:
  // a session that has ENDED but still carries the wallet it used to hold. An
  // unauthenticated session with no wallet fails the address comparison anyway,
  // so it proves nothing on its own -- this pair was green with the session
  // check deleted until this line was added.
  assert.equal(claimableBy({ creator: OWNER }, asset, { state: 'expired', wallet: { address: OWNER } }), false);
  // A session with no wallet is not a match against a launch with no creator:
  // two unreadable values must never compare equal into an affordance.
  assert.equal(claimableBy({ creator: null }, asset, { state: 'authenticated', wallet: {} }), false);
  assert.equal(claimableBy({ creator: '' }, asset, signedIn('')), false);
});

test('nothing accrued, and nothing readable, are both refused', async () => {
  const { claimableBy } = await import('../assets/claim.mjs');
  const mine = { creator: OWNER };

  assert.equal(claimableBy(mine, held('0'), signedIn(OWNER)), false, 'a zero balance would only revert');
  // An unreadable balance is the one that matters: reported as unavailable, it
  // must not become a button. "We could not ask" is not "there is money here".
  assert.equal(
    claimableBy(mine, { state: 'unavailable', problem: 'The escrow balance could not be read.' }, signedIn(OWNER)),
    false
  );
  // And the version that carries a figure anyway -- a partial payload, or one
  // cell that failed after another succeeded. Without it the assertion above
  // passes on the missing number rather than on the state, which is how a
  // deleted state check stayed green.
  assert.equal(
    claimableBy(mine, { state: 'unavailable', accruedWei: '20520000000000000' }, signedIn(OWNER)),
    false
  );
  assert.equal(claimableBy(mine, held('not a number'), signedIn(OWNER)), false);
  assert.equal(claimableBy(mine, {}, signedIn(OWNER)), false);
  assert.equal(claimableBy(mine, held('1'), signedIn(OWNER)), true);
});

test('the page asks with a CSRF token and never invents an outcome it was not given', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.resolve(__dirname, '../assets/app.mjs'), 'utf8');
  const control = source.slice(source.indexOf('function claimControl'), source.indexOf('async function wireCreatorFees'));

  assert.match(control, /X-CSRF-Token/, 'the claim POST must carry the CSRF token');
  assert.match(control, /__Host-ponsr_csrf/);
  assert.match(control, /credentials:\s*'same-origin'/);
  // The subject is the TOKEN address. The service resolves ownership from it
  // against the session's own launches; a database row id is not something any
  // reader can know, and asking for one refuses every real click as not-yours.
  assert.match(control, /token:\s*launch\.token/);
  assert.doesNotMatch(control, /launchId/);
  // Every outcome the service can return is named here. An unnamed one falls to
  // "temporarily unavailable" -- honest, but it must not be where a policy
  // refusal lands, because that sends somebody hunting a bug that is a setting.
  for (const state of ['sent', 'policy-refused', 'nothing-to-claim', 'in-flight', 'not-yours', 'wallet-mismatch', 'unauthenticated']) {
    assert.ok(control.includes(`'${state}'`) || control.includes(`${state}:`), `${state} must be reported in its own words`);
  }
  // A successful send must not re-arm the button: a second click spends gas to
  // be told the balance is already gone.
  assert.match(control, /!==\s*'sent'\)\s*button\.disabled\s*=\s*false/);
});

/**
 * A SUMMARY MUST NEVER FLATTER THE NUMBER UNDERNEATH IT.
 *
 * The panel above the escrow rows used to read "Unavailable" in four boxes with
 * a dead button captioned "Claim execution is deferred". It said that directly
 * above the working collect control on 2026-09-01, the day the owner used it.
 *
 * What replaced it can be wrong in two ways that matter, and both are asserted
 * here with the real figures from the two launches that were collected:
 * swallowing a balance nobody could read, and adding two different assets
 * because they happen to share a decimals field.
 */
test('an unreadable balance is excluded from the total, never counted as zero', async () => {
  const { feeTotals } = await import('../assets/claim.mjs');
  const OWNER = '0xcdce6c82d995d3223d4e956a3c28d36bad875dc0';
  const signedIn = { state: 'authenticated', wallet: { address: OWNER } };

  const totals = feeTotals(
    [
      {
        creator: OWNER,
        assets: [
          { state: 'observed', accruedWei: '20524420520164638', label: 'NVDA' },
          { state: 'unavailable', problem: 'The escrow balance could not be read.' },
        ],
      },
    ],
    signedIn
  );

  assert.equal(totals.accrued, 20524420520164638n);
  assert.equal(totals.unreadable, 1, 'the excluded cell must be counted and reported');
  // The split is the splitter's own constants, and these are the exact figures
  // the chain paid out: 19498199494156406 to the creator, the rest to Ponsr.
  assert.equal(totals.creator, 19498199494156406n);
  assert.equal(totals.treasury, 1026221026008232n);
  assert.equal(totals.creator + totals.treasury, totals.accrued, 'nothing may be left behind');
});

test('two different assets are never added together', async () => {
  const { feeTotals } = await import('../assets/claim.mjs');
  const OWNER = '0xcdce6c82d995d3223d4e956a3c28d36bad875dc0';

  const totals = feeTotals(
    [
      { creator: OWNER, assets: [{ state: 'observed', accruedWei: '20524420520164638', label: 'NVDA' }] },
      { creator: OWNER, assets: [{ state: 'observed', accruedWei: '9443171751664034', label: 'SPCX' }] },
    ],
    { state: 'authenticated', wallet: { address: OWNER } }
  );

  // NVDA and SPCX both carry 18 decimals, so a sum of them formats perfectly and
  // means nothing -- the same shape as the bug that printed a Microduck sell in
  // ETH. The panel reports a count instead of inventing a common currency.
  assert.equal(totals.mixed, true);
  assert.equal(totals.unit, null);
  assert.equal(totals.launches, 2);
});

test('the summary narrows to the reader, and a zero total keeps no unit', async () => {
  const { feeTotals } = await import('../assets/claim.mjs');
  const OWNER = '0xcdce6c82d995d3223d4e956a3c28d36bad875dc0';
  const TREASURY = '0x08e01f1B3156a5D8fE42ED47f09dF5156e7C74Fa';
  const rows = [
    { creator: TREASURY, assets: [{ state: 'observed', accruedWei: '0', label: 'PSTONKS' }] },
    { creator: OWNER, assets: [{ state: 'observed', accruedWei: '7', label: 'NVDA' }] },
  ];

  const mine = feeTotals(rows, { state: 'authenticated', wallet: { address: OWNER } });
  assert.equal(mine.scope, 'mine');
  assert.equal(mine.launches, 1, 'the canary pays the treasury and is not the reader’s');
  assert.equal(mine.accrued, 7n);

  const anyone = feeTotals(rows, { state: 'unauthenticated' });
  assert.equal(anyone.scope, 'public');
  assert.equal(anyone.launches, 2);

  // Everything collected: a number with no unit, not a zero of some asset
  // nobody holds. A zero cell must not claim the unit for the whole panel.
  const empty = feeTotals(
    [{ creator: OWNER, assets: [{ state: 'observed', accruedWei: '0', label: 'NVDA' }] }],
    { state: 'authenticated', wallet: { address: OWNER } }
  );
  assert.equal(empty.unit, null);
  assert.equal(empty.mixed, false);
  assert.equal(empty.accrued, 0n);
});
