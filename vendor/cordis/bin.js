#!/usr/bin/env node

import { Context } from '@snap-rail/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@snap-rail/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@snap-rail/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
