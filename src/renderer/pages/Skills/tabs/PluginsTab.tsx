import { EmptyState } from '../../../components/EmptyState'
import { useT } from '../../../i18n'

export function PluginsTab() {
  const { t } = useT()
  return <EmptyState icon="🧩" title={t('page.skills.plugins.placeholder')} />
}
