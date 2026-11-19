import { HEARING_TYPES, PRACTICE_AREAS, EXPENSE_CATEGORIES } from './domain.js';
import { DOCUMENT_CATEGORY_DEFAULTS } from './documents.js';

/**
 * The pick-lists a firm manages for itself (Settings → Metadata). A firm adds, renames, reorders and archives the
 * entries; the forms offer the active ones. Values are stored as the entry's name, so history reads the same everywhere.
 * To make another pick-list firm-managed, add it here, say where it is stored (`USAGE` in the API), and use
 * `useMetadataOptions` in its form.
 */
export const METADATA_LISTS = [
  {
    key: 'hearing_type',
    title: 'Hearing types',
    singular: 'hearing type',
    description: 'What a hearing is for, chosen when scheduling it (for example Arguments or Evidence).',
    placeholder: 'e.g. Pronouncement of judgment',
    defaults: HEARING_TYPES,
  },
  {
    key: 'document_category',
    title: 'File categories',
    singular: 'file category',
    description: 'How uploaded files are sorted, chosen when you add files to a matter or hearing.',
    placeholder: 'e.g. Affidavits',
    defaults: DOCUMENT_CATEGORY_DEFAULTS,
  },
  {
    key: 'practice_area',
    title: 'Practice areas',
    singular: 'practice area',
    description: 'The kind of work a matter is, chosen when you create or edit a matter.',
    placeholder: 'e.g. Insolvency',
    defaults: PRACTICE_AREAS,
  },
  {
    key: 'expense_category',
    title: 'Expense categories',
    singular: 'expense category',
    description: 'What an expense was for, chosen when you record an expense on a matter.',
    placeholder: 'e.g. Translation',
    defaults: EXPENSE_CATEGORIES,
  },
] as const;

export type MetadataListKey = (typeof METADATA_LISTS)[number]['key'];
export const METADATA_LIST_KEYS = METADATA_LISTS.map((l) => l.key) as unknown as readonly [
  MetadataListKey,
  ...MetadataListKey[],
];
export const metadataList = (key: string) => METADATA_LISTS.find((l) => l.key === key);

/** One entry in a firm's list. Archived entries stay on the records that use them but can't be picked again. */
export type MetadataOptionDto = {
  id: string;
  name: string;
  isActive: boolean;
  position: number;
  inUse: number;
};
