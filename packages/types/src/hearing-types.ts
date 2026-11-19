/** One entry in a firm's list of hearing types. Archived types stay on the hearings that use them but can't be picked again. */
export type HearingTypeDto = { id: string; name: string; isActive: boolean; position: number; inUse: number };
