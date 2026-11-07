import { LOGO_TYPES, MAX_SIGNATURE_BYTES, type LogoContentType, type MemberDto } from '@legalops/types';
import { Alert, Button, TextField } from '@legalops/ui';
import { updateMemberSchema } from '@legalops/validation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
import { MEMBERS_KEY } from '../../lib/hooks.js';

const isImageType = (t: string): t is LogoContentType => t in LOGO_TYPES;

/** Browser → signed PUT straight to storage → the API checks the file and makes it the member's signature. */
async function uploadSignature(memberId: string, file: File): Promise<MemberDto> {
  if (!isImageType(file.type)) throw new Error('That file isn’t a PNG or JPG');
  if (file.size > MAX_SIGNATURE_BYTES) throw new Error('Signature images can be up to 500 KB');
  const start = await api.post<{ uploadId: string; uploadUrl: string }>(`/organization/members/${memberId}/signature/uploads`, {
    contentType: file.type,
    sizeBytes: file.size,
  });
  const put = await fetch(start.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
  if (!put.ok) throw new Error('The upload didn’t go through. Check your connection and try again.');
  return api.post<MemberDto>(`/organization/members/${memberId}/signature/uploads/${start.uploadId}/complete`, {});
}

const errText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message : fallback);

/** Designation text + scanned signature for one member. The caller decides who may see it. */
export function SignatureCard({ member }: { member: MemberDto }) {
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [designation, setDesignation] = useState(member.designation);
  const [fieldError, setFieldError] = useState<string | undefined>();
  // The signature URL never changes; a version in the query string makes the browser refetch after a replace.
  const [version, setVersion] = useState(0);
  const refresh = () => void qc.invalidateQueries({ queryKey: MEMBERS_KEY });

  const saveDesignation = useMutation({
    mutationFn: (value: string) => {
      const parsed = updateMemberSchema.safeParse({ designation: value });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Enter a designation');
      return api.patch<MemberDto>(`/organization/members/${member.id}`, parsed.data);
    },
    onSuccess: (m) => {
      setFieldError(undefined);
      setDesignation(m.designation);
      refresh();
    },
    onError: (e) => {
      const detail = e instanceof ApiError ? e.details.find((d) => d.path === 'designation')?.message : undefined;
      setFieldError(detail ?? errText(e, 'Could not save the designation.'));
    },
  });
  const upload = useMutation({
    mutationFn: (file: File) => uploadSignature(member.id, file),
    onSuccess: () => (setVersion((v) => v + 1), refresh()),
  });
  const remove = useMutation({
    mutationFn: () => api.delete<MemberDto>(`/organization/members/${member.id}/signature`),
    onSuccess: refresh,
  });
  const error = upload.error ?? remove.error;
  const pick = () => (upload.reset(), remove.reset(), input.current?.click());

  return (
    <div className="space-y-4 text-sm">
      <form
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          saveDesignation.mutate(designation);
        }}
        noValidate
      >
        <TextField
          label="Designation"
          hint="Printed under the signature, e.g. Partner"
          maxLength={120}
          value={designation}
          error={fieldError}
          onChange={(e) => (setDesignation(e.target.value), setFieldError(undefined))}
        />
        <Button type="submit" variant="secondary" loading={saveDesignation.isPending} disabled={designation.trim() === member.designation}>
          Save designation
        </Button>
      </form>

      <div className="space-y-3">
        <p className="font-medium">Signature</p>
        {error ? <Alert tone="danger">{errText(error, 'Could not save the signature.')}</Alert> : null}
        {member.hasSignature ? (
          <div className="flex flex-wrap items-center gap-4">
            <div className="grid h-20 w-48 place-items-center rounded-lg border border-line bg-white p-2">
              <img
                src={`/api/v1/organization/members/${member.id}/signature?v=${version}`}
                alt={`Signature of ${member.firstName}`}
                className="max-h-16 max-w-full object-contain"
              />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" icon={<ImageUp className="size-4" />} loading={upload.isPending} onClick={pick}>
                Replace
              </Button>
              <Button type="button" variant="ghost" icon={<Trash2 className="size-4" />} loading={remove.isPending} onClick={() => (upload.reset(), remove.mutate())}>
                Remove
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" icon={<ImageUp className="size-4" />} loading={upload.isPending} onClick={pick}>
              Upload signature
            </Button>
            <span className="text-muted">PNG or JPG, up to 500 KB. A scan on a plain background works best.</span>
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
      </div>
    </div>
  );
}
