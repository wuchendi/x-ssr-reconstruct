import { Link } from '../../components/Link.tsx'

export default function Index() {
  return (
    <section className="profile">
      <h1>Explore</h1>
      <ul>
        <li>
          <Link href="/ada">@ada</Link>
        </li>
        <li>
          <Link href="/grace">@grace</Link>
        </li>
        <li>
          <Link href="/ada/status/1001">A conversation</Link>
        </li>
      </ul>
    </section>
  )
}
