import _ from 'lodash'
import Debug from 'debug'
import isHtml from 'is-html'
import { ServerResponse, IncomingMessage } from 'http'
import {
  RouteMatcherOptionsGeneric,
  STRING_MATCHER_FIELDS,
  DICT_STRING_MATCHER_FIELDS,
  BackendStaticResponse,
} from '../types'
import { Readable, PassThrough } from 'stream'
import CyServer from '@packages/server'
import { Socket } from 'net'
import { GetFixtureFn } from './types'

// TODO: move this into net-stubbing once cy.route is removed
import { parseContentType } from '@packages/server/lib/controllers/xhrs'

const debug = Debug('cypress:net-stubbing:server:util')

export function emit (socket: CyServer.Socket, eventName: string, data: object) {
  debug('sending event to driver %o', { eventName, data })
  socket.toDriver('net:event', eventName, data)
}

export function getAllStringMatcherFields (options: RouteMatcherOptionsGeneric<any>) {
  return _.concat(
    _.filter(STRING_MATCHER_FIELDS, _.partial(_.has, options)),
    // add the nested DictStringMatcher values to the list of fields
    _.flatten(
      _.filter(
        DICT_STRING_MATCHER_FIELDS.map((field) => {
          const value = options[field]

          if (value) {
            return _.keys(value).map((key) => {
              return `${field}.${key}`
            })
          }

          return ''
        }),
      ),
    ),
  )
}

/**
 * Generate a "response object" that looks like a real Node HTTP response.
 * Instead of directly manipulating the response by using `res.status`, `res.setHeader`, etc.,
 * generating an IncomingMessage allows us to treat the response the same as any other "real"
 * HTTP response, which means the proxy layer can apply response middleware to it.
 */
function _getFakeClientResponse (opts: {
  statusCode: number
  headers: {
    [k: string]: string
  }
  body: string
}) {
  const clientResponse = new IncomingMessage(new Socket)

  // be nice and infer this content-type for the user
  if (!_.keys(opts.headers).map(_.toLower).includes('content-type') && isHtml(opts.body)) {
    opts.headers['content-type'] = 'text/html'
  }

  _.merge(clientResponse, opts)

  return clientResponse
}

const caseInsensitiveGet = function (obj, lowercaseProperty) {
  for (let key of Object.keys(obj)) {
    if (key.toLowerCase() === lowercaseProperty) {
      return obj[key]
    }
  }
}

export async function setBodyFromFixture (getFixtureFn: GetFixtureFn, staticResponse: BackendStaticResponse) {
  const { fixture } = staticResponse

  if (!fixture) {
    return
  }

  const data = await getFixtureFn(fixture.filePath, { encoding: fixture.encoding })

  const { headers } = staticResponse

  if (!headers || !caseInsensitiveGet(headers, 'content-type')) {
    _.set(staticResponse, 'headers.content-type', parseContentType(data))
  }

  function getBody (): string {
  // NOTE: for backwards compatibility with cy.route
    if (data === null) {
      return ''
    }

    if (!_.isBuffer(data) && !_.isString(data)) {
    // TODO: probably we can use another function in fixtures.js that doesn't require us to remassage the fixture
      return JSON.stringify(data)
    }

    return data
  }

  staticResponse.body = getBody()
}

/**
 * Using an existing response object, send a response shaped by a StaticResponse object.
 * @param res Response object.
 * @param staticResponse BackendStaticResponse object.
 * @param onResponse Will be called with the response metadata + body stream
 * @param resStream Optionally, provide a Readable stream to be used as the response body (overrides staticResponse.body)
 */
export function sendStaticResponse (res: ServerResponse, staticResponse: BackendStaticResponse, onResponse: (incomingRes: IncomingMessage, stream: Readable) => void, resStream?: Readable) {
  if (staticResponse.forceNetworkError) {
    res.connection.destroy()
    res.destroy()

    return
  }

  const statusCode = staticResponse.statusCode || 200
  const headers = staticResponse.headers || {}
  const body = resStream ? '' : staticResponse.body || ''

  const incomingRes = _getFakeClientResponse({
    statusCode,
    headers,
    body,
  })

  if (!resStream) {
    const pt = new PassThrough()

    if (staticResponse.body) {
      pt.write(staticResponse.body)
    }

    pt.end()

    resStream = pt
  }

  onResponse(incomingRes, resStream)
}
