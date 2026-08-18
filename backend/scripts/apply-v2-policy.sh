#!/usr/bin/env bash
#
# Widens the bot's Turnkey policy to allow the pons v2 factory.
#
#   bash scripts/apply-v2-policy.sh            # plan only, touches nothing
#   bash scripts/apply-v2-policy.sh --execute
#
# WHY THIS WRAPPER EXISTS
# -----------------------
# The underlying script needs the Turnkey ROOT credentials, and root bypasses the
# policy engine entirely -- it is the one key that can rewrite the treasury's guard
# rails. The obvious way to supply it is to paste it onto a command line, which puts
# it into shell history, the process list, and any terminal scrollback that gets
# shared later.
#
# This reads the two values straight out of the key file into this process's
# environment and passes them to one command. They are never printed, never written
# anywhere, and never leave this machine except to Turnkey itself.
#
# AFTERWARDS: the key file should not survive this. A fresh root API key can be
# minted from the Turnkey dashboard with a passkey at any time, so deleting it loses
# nothing -- and a root credential sitting in a plaintext file beside a running bot
# is the thing the whole scoped-user design exists to avoid.

set -euo pipefail

KEY_FILE="${TURNKEY_ROOT_KEY_FILE:-$HOME/ponsr-turnkey-root-key.txt}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/.."

if [ ! -f "$KEY_FILE" ]; then
  echo "Root key file not found: $KEY_FILE" >&2
  echo "" >&2
  echo "If you have already moved it into a password manager (good), supply the two" >&2
  echo "values for this one command instead:" >&2
  echo "" >&2
  echo "  TURNKEY_ROOT_PUBLIC_KEY=... TURNKEY_ROOT_PRIVATE_KEY=... \\" >&2
  echo "    npx tsx scripts/turnkey-allow-v2-factory.ts --execute" >&2
  exit 1
fi

# Read only the two names we need, and only their values -- not the whole file, which
# may contain other things that have no business in this environment.
ROOT_PUB="$(grep -m1 '^TURNKEY_ROOT_API_PUBLIC_KEY=' "$KEY_FILE" | cut -d= -f2- | tr -d '"'"'"' \r')"
ROOT_PRIV="$(grep -m1 '^TURNKEY_ROOT_API_PRIVATE_KEY=' "$KEY_FILE" | cut -d= -f2- | tr -d '"'"'"' \r')"

if [ -z "$ROOT_PUB" ] || [ -z "$ROOT_PRIV" ]; then
  echo "Could not read both TURNKEY_ROOT_API_PUBLIC_KEY and TURNKEY_ROOT_API_PRIVATE_KEY" >&2
  echo "from $KEY_FILE. Nothing was attempted." >&2
  exit 1
fi

echo "Read the root credentials from $KEY_FILE (values not shown)."
echo ""

TURNKEY_ROOT_PUBLIC_KEY="$ROOT_PUB" \
TURNKEY_ROOT_PRIVATE_KEY="$ROOT_PRIV" \
  npx tsx scripts/turnkey-allow-v2-factory.ts "$@"

# Only reached when the command above succeeded.
if [[ " $* " == *" --execute "* ]]; then
  echo ""
  echo "=============================================================="
  echo "NEXT, AND DO NOT SKIP IT:"
  echo ""
  echo "  npx tsx scripts/turnkey-verify-policy.ts"
  echo ""
  echo "Look at check 3. An arbitrary destination must still read DENIED."
  echo "A policy that is too wide looks exactly like a correct one until the"
  echo "morning it matters, and that is the only line that tells them apart."
  echo ""
  echo "THEN: move $KEY_FILE into a password manager and delete it."
  echo "Root bypasses every policy, so it undoes all of the above while it sits"
  echo "in plaintext beside the bot. A new one can be minted with a passkey."
  echo "=============================================================="
fi
