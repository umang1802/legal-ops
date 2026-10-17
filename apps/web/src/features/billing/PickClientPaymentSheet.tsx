import { Sheet, type ComboOption } from '@legalops/ui';
import { useEffect, useState } from 'react';
import { ClientPicker } from '../matters/pickers.js';
import { RecordPaymentSheet } from './RecordPaymentSheet.js';

/** "Record payment" from the billing home: pick the client first, then the regular payment sheet. */
export function PickClientPaymentSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [client, setClient] = useState<ComboOption | null>(null);
  useEffect(() => {
    if (open) setClient(null);
  }, [open]);
  if (client)
    return (
      <RecordPaymentSheet open={open} onClose={onClose} client={{ id: client.value, name: client.label }} />
    );
  return (
    <Sheet open={open} onClose={onClose} title="Payment from which client?">
      <ClientPicker value={null} onChange={setClient} />
    </Sheet>
  );
}
