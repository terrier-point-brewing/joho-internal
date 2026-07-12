import TaxWorksheetShell from "./TaxWorksheetShell";

export default async function TaxTaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  return <TaxWorksheetShell taskId={taskId} />;
}
