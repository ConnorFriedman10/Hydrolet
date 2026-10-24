import Placeholder from '../components/Placeholder'

// Hidden page at /dev, not linked from the nav.
export default function Dev() {
  return (
    <Placeholder title="Dev tools">
      <li>Write fake events ("Simulate sip of 150 mL")</li>
      <li>Register a coaster or watch and show its secret once</li>
      <li>Send today's summary now</li>
    </Placeholder>
  )
}
