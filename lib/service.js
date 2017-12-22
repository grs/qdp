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
var opentracing = require('opentracing');
var jaeger = require('jaeger-client');
var initTracer = jaeger.initTracer;
var amqp = require('rhea');
var common = require('./common.js');

function Service(def, parent) {
    var parts = def.split('=');
    this.service = parts[0];
    parts = parts.length === 2 ? parts[1].split(':') : [];
    this.host = parts[0] || 'localhost';
    this.port = parts[1] || 80;
    this.tracer = parent.tracer;
    this.receiver = parent.connection.open_receiver(this.service);
    console.log('subscribed to %s => %s:%s', this.service, this.host, this.port);
    this.receiver.on('message', this.on_message.bind(this));
};

Service.prototype.on_message = function (context) {
    console.log('server got message: %s %s %s', context.message.subject, context.message.to, context.message.application_properties.path);
    var parentSpanContext = this.tracer.extract(opentracing.FORMAT_HTTP_HEADERS, context.message.message_annotations);
    var span = this.tracer.startSpan(context.message.to, { childOf: parentSpanContext });
    span.setTag(opentracing.Tags.HTTP_URL, context.message.to);
    span.setTag(opentracing.Tags.HTTP_METHOD, context.message.subject);
    span.setTag(opentracing.Tags.COMPONENT, 'qdr-proxy');
    span.setTag(opentracing.Tags.SPAN_KIND, opentracing.Tags.SPAN_KIND.SERVER);

    var path = context.message.application_properties ? context.message.application_properties.path : '';
    var url = url_parse('http://' + context.message.to + path);
    var headers = {};
    this.tracer.inject(span, opentracing.FORMAT_HTTP_HEADERS, headers);
    common.remove_nulls(headers);
    for (var key in context.message.application_properties) {
        if (key !== 'path') {
            headers[key] = context.message.application_properties[key];
        }
    }
    if (context.message.content_type) {
        headers['content-type'] = context.message.content_type;
    }

    var options = {
        host: this.host,
        port: this.port,
        path: url.path,
        method: context.message.subject,
        headers: headers
    };
    console.log('making inbound request: %j', options);
    var request = http.request(options, function (response) {
        console.log('got response to inbound request: %s', response.statusCode);
        var message_out = {
            to: context.message.reply_to,
            correlation_id: context.message.correlation_id,
            subject: '' + response.statusCode,
            application_properties: {},
            body: ''
        };
        for (var key in response.headers) {
            if (key === 'content-type') {
                message_out.content_type = response.headers['content-type'];
            } else {
                message_out.application_properties[key] = response.headers[key]
            }
        }
	response.on('data', function (chunk) { message_out.body += chunk; });
	response.on('end', function () {
            span.setTag(opentracing.Tags.HTTP_STATUS_CODE, response.statusCode);
            console.log('server sending reply: %j', message_out);
            context.connection.send(message_out);
            span.finish();
        });
    });
    request.write(context.message.body);
    request.end();
};

Service.prototype.close = function () {
    this.receiver.close();
};

function ServiceHandler (options, tracer) {
    this.tracer = tracer;
    this.connection = amqp.connect(options);
    this.subscriptions = [];
}

ServiceHandler.prototype.subscribe = function (definition) {
    this.subscriptions.push(new Service(definition, this));
};

ServiceHandler.prototype.close = function () {
    this.subscriptions.forEach(function (s) {
        s.close();
    });
    this.subscriptions = [];
    this.connection.close();
};

module.exports.subscriber = function (options, tracer) {
    return new ServiceHandler(options, tracer);
};
