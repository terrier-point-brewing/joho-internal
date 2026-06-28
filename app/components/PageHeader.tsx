export default function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mt-4 mb-2">
      <h2 className="text-base font-medium text-zinc-100">{title}</h2>
      {description && <p className="text-sm text-zinc-500 mt-0.5">{description}</p>}
    </div>
  );
}
