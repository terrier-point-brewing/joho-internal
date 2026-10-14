export default function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mt-2 sm:mt-4 mb-2">
      <h2 className="text-base font-semibold text-primary">{title}</h2>
      {/* On a phone the description is read by assistive tech but takes no
          space: the frozen header is already a third of the screen there
          (docs/ui/MOBILE_REVIEW.md), and the description carries no
          navigation value while scrolling. */}
      {description && <p className="text-sm text-muted mt-1 max-sm:sr-only">{description}</p>}
    </div>
  );
}
