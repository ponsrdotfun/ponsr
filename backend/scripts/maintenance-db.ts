#!/usr/bin/env node
import { runMaintenanceCli } from '../src/maintenanceBackup';

runMaintenanceCli(process.argv.slice(2)).catch((error: any) => {
  process.stderr.write(`maintenance-db: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
