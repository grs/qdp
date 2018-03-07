/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var http = require('http');
var https = require('https');
var url_parse = require('url').parse;
var util = require('util');
var client = require('../lib/client.js');
var common = require('../lib/common.js');
var service = require('../lib/service.js');
var relay = require('../lib/relay.js');
var opentracing = require('opentracing');
var jaeger = require('jaeger-client');
var initTracer = jaeger.initTracer;

function router_conf () {
    return {
        host: process.env.MESSAGING_SERVICE_HOST,
        port: process.env.MESSAGING_SERVICE_PORT
    };
}

var requester = client.connect(router_conf());

const service_name = process.env.SERVICE_NAME || process.env.HOSTNAME;
var config = {
    'serviceName': service_name,
    reporter: {
        flushIntervalMs: 1000,
        agentHost: process.env.JAEGER_SERVER_HOSTNAME || 'localhost',
        agentPort: 6832
    },
    sampler: {
        type: 'const',
        param: 1,
        refreshIntervalMs: 1000
    }
};
var tags = {};
tags[service_name] = process.env.SERVICE_VERSION || '0.1';

var options = {
    //'metrics': metrics, //???
    //'logger': logger,    //???
    'tags': tags
};
var tracer = initTracer(config, options);
var codec = new jaeger.ZipkinB3TextMapCodec({ urlEncoding: true });
tracer.registerInjector(opentracing.FORMAT_HTTP_HEADERS, codec);
tracer.registerExtractor(opentracing.FORMAT_HTTP_HEADERS, codec);
var domain = process.env.QDP_DOMAIN;

function outbound (request, response) {
    var url = url_parse(request.url);
    var path = url.pathname;
    var address = request.headers.host ? request.headers.host.split(':')[0] : url_parse(request.url);
    if (domain && address.endsWith(domain)) {
        address = address.substr(0, address.length - domain.length);
    }
    console.log('outgoing request %s (%s)', request.headers.host, address);

    var parentSpanContext = tracer.extract(opentracing.FORMAT_HTTP_HEADERS, request.headers);
    var span = tracer.startSpan(path, { childOf: parentSpanContext });
    span.setTag(opentracing.Tags.HTTP_URL, path);
    span.setTag(opentracing.Tags.HTTP_METHOD, request.method);
    span.setTag(opentracing.Tags.COMPONENT, 'qdr-proxy');
    span.setTag(opentracing.Tags.SPAN_KIND, opentracing.Tags.SPAN_KIND.CLIENT);

    var body = '';
    request.on('data', function (data) { body += data; });
    request.on('end', function () {
        var message_out = {
            to: address,
            subject: request.method,
            application_properties: {},
            message_annotations: {},
            body: body
        };
        for (var key in request.headers) {
            if (key === 'content-type') {
                message_out.content_type = request.headers[key];
            } else {
                message_out.application_properties[key] = request.headers[key];
            }
        }
        message_out.application_properties['path'] = path;
        tracer.inject(span, opentracing.FORMAT_HTTP_HEADERS, message_out.message_annotations);
        common.remove_nulls(message_out.message_annotations);

        console.log('client sending message: %s %s %s', message_out.subject, message_out.to, message_out.application_properties.path);
        requester.request(message_out).then(function (message_in) {
            console.log('got reply for outbound request: %s %s %s', message_in.subject, message_in.to, message_in.application_properties ? message_in.application_properties.path : undefined);
            for (var key in message_in.application_properties) {
                response.setHeader(key, message_in.application_properties[key]);
            }
            response.statusCode = message_in.subject || 203;
            if (message_in.content_type) {
                response.setHeader('content-type', message_in.content_type);
            }
            response.end(message_in.body);
            span.setTag(opentracing.Tags.HTTP_STATUS_CODE, response.statusCode)
            span.finish();
        }).catch(function (error) {
            console.error(error);
            span.setTag(opentracing.Tags.HTTP_STATUS_CODE, 500)
            span.setTag(opentracing.Tags.ERROR, true)
            span.log({
                event: 'error',
                message: error.message,
                error
            })
            span.finish();
            response.statusCode = 500;
            response.end(error.toString());
        });
    });
}

var server = http.createServer(outbound);
var port = process.env.QDR_PROXY_PORT || 15001;
server.listen(port, '0.0.0.0');

var subscriber = service.subscriber(router_conf(), tracer);
for (var i = 2; i < process.argv.length; i++) {
    subscriber.subscribe(process.argv[i]);
}

var amqp_server = relay.server(service_name + '-proxy', router_conf(), tracer);
amqp_server.listen({port:process.env.QDR_AMQP_RELAY_PORT || 5672});
