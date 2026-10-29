import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABELS, type DocumentCategory, type DocumentDto, type MatterDetailDto } from '@legalops/types';
import { Button, Card, CardHeader, SearchInput, Sheet } from '@legalops/ui';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useState } from 'react';
import { api, qs } from '../../lib/api.js';
import { canAct, useSession } from '../../lib/auth.js';
import { DocumentList } from './DocumentList.js';
import { DocumentUploader } from './DocumentUploader.js';

export function MatterDocumentsTab({ matter, uploading, setUploading }: { matter: MatterDetailDto; uploading: boolean; setUploading: (v: boolean) => void }) {
  const me = useSession();
  const isAdmin = me.role === 'owner' || me.role === 'admin';
  const [category, setCategory] = useState<DocumentCategory | ''>('');
  const [caseId, setCaseId] = useState('');
  const [search, setSearch] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const q = useQuery({
    queryKey: ['documents', 'matter', matter.id, category, caseId, search, showDeleted],
    queryFn: () => api.get<DocumentDto[]>(`/documents${qs({ matterId: matter.id, category, caseId, search, includeDeleted: showDeleted || undefined })}`),
    placeholderData: keepPreviousData, // keep the list on screen while a filter or search changes
  });

  return (
    <Card>
      <CardHeader
        title={`Documents${q.data ? ` (${q.data.filter((d) => d.status === 'available').length})` : ''}`}
        action={
          canAct(me, 'documents.upload') ? (
            <Button size="sm" icon={<Upload className="size-4" />} onClick={() => setUploading(true)}>
              Upload
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3 sm:px-5">
        <SearchInput className="min-w-0 flex-1" placeholder="Search file names" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as DocumentCategory | '')} className="h-10 rounded-lg border border-line bg-surface px-3 text-sm">
          <option value="">All categories</option>
          {DOCUMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {DOCUMENT_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
        {matter.cases.length > 1 ? (
          <select aria-label="Case" value={caseId} onChange={(e) => setCaseId(e.target.value)} className="h-10 rounded-lg border border-line bg-surface px-3 text-sm">
            <option value="">All cases</option>
            {matter.cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.caseNumber ?? c.title}
              </option>
            ))}
          </select>
        ) : null}
        {isAdmin ? (
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} className="size-4" />
            Show deleted
          </label>
        ) : null}
      </div>
      <DocumentList docs={q.data} loading={q.isPending} emptyHint="Upload case papers, orders and evidence for this matter." />
      <Sheet open={uploading} onClose={() => setUploading(false)} title={`Upload to ${matter.title}`}>
        <DocumentUploader matterId={matter.id} cases={matter.cases} onDone={() => setUploading(false)} />
      </Sheet>
    </Card>
  );
}
