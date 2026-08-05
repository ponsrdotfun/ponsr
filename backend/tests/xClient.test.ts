import { SplitXClient, XReader, XWriter, XApiWriter, TwitterApiIoReader } from '../src/xClient';
import { composeSuccessReply } from '../src/replyComposer';
import { AccountSignals, InboundMention } from '../src/types';

/**
 * Reads and writes go to different providers. These tests guard the two properties that
 * decision rests on -- that the split is real, and that the URL cost is opted into.
 */

class FakeReader implements XReader {
  public reads = 0;
  async getAccountSignals(xUserId: string): Promise<AccountSignals> {
    this.reads++;
    return { xUserId, accountCreatedAt: new Date(0).toISOString(), followerCount: 1 };
  }
  async getRecentMentions(): Promise<InboundMention[]> {
    this.reads++;
    return [];
  }
}
class FakeWriter implements XWriter {
  public writes = 0;
  async postReply(): Promise<{ tweetId: string }> {
    this.writes++;
    return { tweetId: 'w1' };
  }
}

describe('SplitXClient', () => {
  it('CRITICAL: reads never touch the writer, and writes never touch the reader', async () => {
    // The whole point of the split: posting is account activity that can get @ponsrdotfun
    // suspended, reading is not. If a read ever went out through the write path, the risk
    // being avoided would be back without anyone noticing.
    const reader = new FakeReader();
    const writer = new FakeWriter();
    const client = new SplitXClient(reader, writer);

    await client.getAccountSignals('u1');
    await client.getRecentMentions('1970-01-01T00:00:00.000Z');
    expect(reader.reads).toBe(2);
    expect(writer.writes).toBe(0);

    await client.postReply('t1', 'hello');
    expect(writer.writes).toBe(1);
    expect(reader.reads).toBe(2);
  });

  it('still satisfies the XClient interface the orchestrator depends on', () => {
    const client = new SplitXClient(new FakeReader(), new FakeWriter());
    for (const m of ['postReply', 'getAccountSignals', 'getRecentMentions']) {
      expect(typeof (client as any)[m]).toBe('function');
    }
  });
});

describe('providers refuse to run unconfigured', () => {
  it('the reader names the missing key before anything else', async () => {
    // Ordering matters: with no key configured, complaining about a missing handle would
    // send someone looking in the wrong place entirely.
    await expect(new TwitterApiIoReader('', 'ponsrdotfun').getAccountSignals('u1', 'someone'))
      .rejects.toThrow(/TWITTERAPI_IO_KEY/);
    await expect(new TwitterApiIoReader('', 'ponsrdotfun').getAccountSignals('u1'))
      .rejects.toThrow(/TWITTERAPI_IO_KEY/);
  });

  it('CRITICAL: refuses a lookup with no handle rather than querying the wrong thing', async () => {
    // twitterapi.io keys user lookups on the handle and rejects a numeric id outright. A
    // silent wrong query here would make every account look brand new with no followers,
    // and the bot would turn away every user with a message about their account age.
    await expect(new TwitterApiIoReader('k', 'ponsrdotfun').getAccountSignals('u1'))
      .rejects.toThrow(/handle/i);
  });

  it('the writer says which keys are missing', async () => {
    await expect(new XApiWriter('', '', '', '').postReply('t1', 'hi'))
      .rejects.toThrow(/X_API_KEY/);
  });
});

describe('the success reply and the price of a link', () => {
  const base = {
    tokenName: 'Moon Coin',
    tokenSymbol: 'MOON',
    tokenAddress: '0x' + '11'.repeat(20),
    txHash: '0x' + '22'.repeat(32),
  };

  it('CRITICAL: includes no URL by default', () => {
    // X charges $0.200 for a post containing a URL against $0.015 without -- 13x. Off by
    // default so the cost is chosen, not discovered on an invoice.
    const text = composeSuccessReply({ ...base, includeLink: false });
    expect(text).not.toMatch(/https?:\/\//);
  });

  it('still carries the contract address, which is what the recipient needs', () => {
    expect(composeSuccessReply({ ...base, includeLink: false })).toContain(base.tokenAddress);
  });

  it('adds the token page link when the cost is opted into', () => {
    const text = composeSuccessReply({ ...base, includeLink: true, siteBaseUrl: 'https://ponsr.fun' });
    expect(text).toContain('https://ponsr.fun/token/MOON');
  });

  it('escapes the symbol into the link rather than trusting it', () => {
    // Symbols are sanitised upstream, but a URL built by string concatenation is exactly
    // where an unexpected character becomes someone else's problem.
    const text = composeSuccessReply({
      ...base, tokenSymbol: 'A B', includeLink: true, siteBaseUrl: 'https://ponsr.fun',
    });
    expect(text).toContain('/token/A%20B');
  });
});
