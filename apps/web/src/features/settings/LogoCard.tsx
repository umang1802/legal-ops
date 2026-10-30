import { LOGO_TYPES, MAX_LOGO_BYTES, type LogoContentType, type OrganizationDto } from '@legalops/types';
import { Alert, Button, Card, CardBody, CardHeader, Sheet } from '@legalops/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { ME_KEY } from '../../lib/auth.js';

const isLogoType = (t: string): t is LogoContentType => t in LOGO_TYPES;

/** Browser → signed PUT straight to storage → the API checks the file and makes it the firm's logo. */
async function uploadLogo(file: File): Promise<OrganizationDto> {
  if (!isLogoType(file.type)) throw new Error('That file isn’t a PNG or JPG');
  if (file.size > MAX_LOGO_BYTES) throw new Error('Logos can be up to 1 MB');
  const start = await api.post<{ logoId: string; uploadUrl: string }>('/organization/logo/uploads', { contentType: file.type, sizeBytes: file.size });
  const put = await fetch(start.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!put.ok) throw new Error('The upload didn’t go through. Check your connection and try again.');
  return api.post<OrganizationDto>(`/organization/logo/${start.logoId}/complete`, {});
}

export function LogoCard({ org }: { org: OrganizationDto }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const saved = (o: OrganizationDto) => {
    qc.setQueryData(['organization'], o);
    void qc.invalidateQueries({ queryKey: ME_KEY }); // sidebar and mobile header
  };
  const upload = useMutation({ mutationFn: uploadLogo, onSuccess: saved });
  const remove = useMutation({
    mutationFn: () => api.delete<OrganizationDto>('/organization/logo'),
    onSuccess: (o) => (saved(o), setConfirmRemove(false)),
  });
  const error = upload.error ?? remove.error;
  const pick = () => (upload.reset(), remove.reset(), input.current?.click());

  return (
    <Card>
      <CardHeader title="Logo" description="Shown in the app, on invoices and receipts, and in emails to clients." />
      <CardBody className="space-y-3 text-sm">
        {error ? <Alert tone="danger">{error instanceof ApiError || error instanceof Error ? error.message : 'Could not save the logo.'}</Alert> : null}
        {org.logoUrl ? (
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid h-20 w-48 place-items-center rounded-lg border border-line bg-white p-2">
              <img src={org.logoUrl} alt={`${org.name} logo`} className="max-h-16 max-w-full object-contain" />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" icon={<ImageUp className="size-4" />} loading={upload.isPending} onClick={pick}>
                Replace
              </Button>
              <Button type="button" variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => (remove.reset(), setConfirmRemove(true))}>
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" icon={<ImageUp className="size-4" />} loading={upload.isPending} onClick={pick}>
              Upload logo
            </Button>
            <span className="text-muted">PNG or JPG, up to 1 MB.</span>
          </div>
        )}
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) upload.mutate(file);
          }}
        />
      </CardBody>
      <Sheet
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remove the logo?"
        footer={
          <div className="flex gap-2 sm:justify-end">
            <Button type="button" variant="secondary" block className="sm:w-auto" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button type="button" variant="danger" block className="sm:w-auto" loading={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm text-ink-soft">
          <p>Your firm’s name will show instead. Emails already sent keep their logo.</p>
          {remove.error ? <Alert tone="danger">{remove.error instanceof ApiError ? remove.error.message : 'Could not remove the logo.'}</Alert> : null}
        </div>
      </Sheet>
    </Card>
  );
}
