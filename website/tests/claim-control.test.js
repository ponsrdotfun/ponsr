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
