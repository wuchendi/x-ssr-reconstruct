export function PostSkeletons({ n = 3 }: { n?: number }) {
  return (
    <div aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders with no identity, never reordered
        <div key={i} className="post skeleton" />
      ))}
    </div>
  )
}
