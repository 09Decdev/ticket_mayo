export function Spinner({ large }: { large?: boolean }) {
  return (
    <div className="center">
      <span className={large ? 'spinner spinner-lg' : 'spinner'} aria-label="loading" />
    </div>
  );
}
