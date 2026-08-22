import * as fs from 'fs';
import * as path from 'path';

const scriptsDir = path.join(__dirname, '../scripts');
const manifestPath = path.join(scriptsDir, 'authority-manifest.json');

type Entry = {
  script: string;
  authority: 'read-only' | 'signing' | 'local-write' | 'remote-mutation' | 'broadcast';
  effects: string[];
  defaultMode: 'read-only' | 'plan-only' | 'signer-active';
  explicitGate?: string;
};

describe('script authority manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version: number; scripts: Entry[] };

  it('classifies every executable in backend/scripts exactly once', () => {
    const onDisk = fs.readdirSync(scriptsDir)
      .filter((f) => /\.(ts|sh|ps1)$/.test(f))
      .sort();
    const classified = manifest.scripts.map((x) => x.script).sort();
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified).toEqual(onDisk);
  });

  it('declares truthful effects and default behavior for every entrypoint', () => {
    for (const entry of manifest.scripts) {
      expect(entry.effects.length).toBeGreaterThan(0);
      expect(['read-only', 'plan-only', 'signer-active']).toContain(entry.defaultMode);
      if (entry.authority === 'signing') expect(entry.defaultMode).toBe('signer-active');
      if (entry.authority === 'broadcast' || entry.authority === 'remote-mutation') {
        expect(entry.defaultMode).toBe('plan-only');
        expect(entry.explicitGate).toBeTruthy();
      }
    }
  });

  it('declares the exact source gate token for sensitive optional effects', () => {
    const byScript = new Map(manifest.scripts.map((entry) => [entry.script, entry]));
    expect(byScript.get('check-providers.ts')?.explicitGate).toBe('--create-privy-wallet');
    expect(byScript.get('check-x-credentials.ts')?.explicitGate).toBe('--post-test');
    for (const entry of manifest.scripts.filter((item) => item.explicitGate)) {
      expect(fs.readFileSync(path.join(scriptsDir, entry.script), 'utf8')).toContain(entry.explicitGate!);
    }
  });

  it('wallet, cold-address, and provider resource writers are inert by default', () => {
    const expectations: Record<string, string> = {
      'new-treasury-wallet.ts': '--write',
      'set-cold-address.ts': '--write',
      'check-providers.ts': '--create-privy-wallet',
    };
    for (const [file, flag] of Object.entries(expectations)) {
      const code = fs.readFileSync(path.join(scriptsDir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      expect(code).toContain(flag);
      const gate = code.indexOf(flag);
      const effect = code.search(/appendFileSync|writeFileSync|resolver\.resolve/);
      expect(gate).toBeGreaterThan(-1);
      expect(effect).toBeGreaterThan(gate);
    }
  });
});
