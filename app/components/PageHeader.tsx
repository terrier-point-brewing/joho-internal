export default function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mt-4 mb-2">
      <h2 className="text-base font-semibold text-primary">{title}</h2>
      {description && <p className="text-sm text-muted mt-1">{description}</p>}
    </div>
  );
}
