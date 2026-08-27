/**
 * The renderer entry: bootstrap the kernel, then hand the React root over to
 * the client runtime with this build's occupant list — layout, chrome, and
 * dashboard are residents of phase 1; the boot-graph loader replaces the
 * in-app list when plugins ship as directories.
 *
 * @module @snap-rail/desktop/client-main
 */

import titlebarPlugin from '@snap-rail/chrome-titlebar'
import { bootClient } from '@snap-rail/client-kernel'
import layoutPlugin from '@snap-rail/layout-default'
import manageConnectionsPlugin from '@snap-rail/manage-connections'
import managePluginsPlugin from '@snap-rail/manage-plugins'
import dashboardPlugin from '@snap-rail/panel-dashboard'
import { createClientRuntime } from '@snap-rail/client-runtime'

const element = document.getElementById('root')
if (element === null) throw new Error('client: #root is missing from index.html')

const handle = await bootClient({ element })
await createClientRuntime(handle, {
  plugins: [layoutPlugin, titlebarPlugin, dashboardPlugin, managePluginsPlugin, manageConnectionsPlugin],
})
