interface Props {
  label: string;
  hint?: string;
}

export default function PlaceholderPage({ label, hint }: Props) {
  return (
    <div className="placeholder">
      <strong>{label}</strong>
      {hint ?? '此页面尚未实现 · 设计稿先行 · 后续版本接入'}
    </div>
  );
}
