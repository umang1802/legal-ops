/** A firm's logo, or nothing when it has none (callers keep their text name as the fallback). */
export function FirmLogo({ name, logoUrl, className = '' }: { name: string; logoUrl: string | null; className?: string }) {
  if (!logoUrl) return null;
  return <img src={logoUrl} alt={name} className={`block w-auto object-contain object-left ${className}`} />;
}
