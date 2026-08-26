/**
 * The renderer entry: bootstrap the client kernel into the root element.
 * Everything else — layout, panels, plugin management — arrives as client
 * plugins mounted by the client runtime.
 *
 * @module @snap-rail/desktop/client-main
 */

import { bootClient } from '@snap-rail/client-kernel'

const element = document.getElementById('root')
if (element === null) throw new Error('client: #root is missing from index.html')

void bootClient({ element })
