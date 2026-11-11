export function PostSkeletons({ n = 3 }: { n?: number }) {
  return (
    <div aria-busy="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="post skeleton" />
      ))}
    </div>
  )
}
