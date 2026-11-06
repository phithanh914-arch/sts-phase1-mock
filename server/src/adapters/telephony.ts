// TelephonyAdapter（模擬）。実Genesysへは接続しない。
// TRANSFER_REQUESTED と TRANSFERRED を区別し、完了応答前に「転送しました」と扱わない。

import type { FaultConfig } from './faults.js';

export type TransferTarget = 'TOWING_DESK' | 'OPERATOR' | 'OPERATOR_EMERGENCY';

export interface HandoffPackage {
  conversation_id: string;
  route: string;
  reason: string[];
  safety_flags: string[];
  captured_facts: Record<string, unknown>;
  unresolved: string[];
  caller_contact: { name_kana: unknown; callback_phone: unknown };
  transcript_ref: string;
  registration_status: string;
}

export interface TransferResult {
  transferId: string;
  target: TransferTarget;
  status: 'TRANSFERRED' | 'TRANSFER_FAILED';
  at: string;
  mock: true;
}

let seq = 0;
export function createTelephonyAdapter(getFaults: () => FaultConfig) {
  return {
    requestTransfer(target: TransferTarget, pkg: HandoffPackage, onResult: (r: TransferResult) => void): string {
      const transferId = `MOCK-TRANSFER-${++seq}`;
      const f = getFaults();
      void pkg;
      setTimeout(() => {
        onResult({
          transferId,
          target,
          status: f.transfer === 'fail' ? 'TRANSFER_FAILED' : 'TRANSFERRED',
          at: new Date().toISOString(),
          mock: true,
        });
      }, f.transferDelayMs);
      return transferId;
    },
  };
}
export type TelephonyAdapter = ReturnType<typeof createTelephonyAdapter>;
