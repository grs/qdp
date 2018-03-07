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

var opentracing = require('opentracing');
var rhea = require('rhea');
var common = require('./common');

function bind(source, target, event, method) {
    source.on(event, target[method || 'on_' + event].bind(target));
}

function link(a, b) {
    a.relay = b;
    b.relay = a;
}

function unlink(a) {
    a.relay.relay = undefined;
    a.relay = undefined;
}

function close(endpoint, error, frame_type) {
    if (endpoint.relay) {
        endpoint.relay.local[frame_type].error = error || endpoint.remote[frame_type].error;
        endpoint.relay.close();
        unlink(endpoint);
    }
}

function close_link(endpoint, error) {
    close(endpoint, error, 'detach');
}

function close_connection(endpoint, error) {
    close(endpoint, error, 'close');
}

function copy(original, fields) {
    let copy = {};
    for (let k in original) {
        if (fields === undefined || fields.indexOf(k) >= 0) {
            copy[k] = original[k];
        }
    }
    return copy;
}

const source_fields = ['address', 'durable', 'expiry-policy', 'timeout', 'distribution_mode', 'filter', 'default_outcome', 'outcomes', 'capabilities'];
const target_fields = ['address', 'durable', 'expiry-policy', 'timeout', 'capabilities'];

function get_relay_source(source) {
    let s = copy(source, source_fields);
    if (source.dynamic) {
        s.address = rhea.generate_uuid();
    }
    return s;
}

function merge() {
    return Array.prototype.slice.call(arguments).reduce(function (a, b) {
        for (var key in b) {
            a[key] = b[key];
        }
        return a;
    });
}

function RelayServer (name, downstream_details, tracer) {
    this.name = name;
    this.downstream_details = downstream_details;
    this.tracer = tracer;
    this.upstream = rhea.create_container({container_id:name, autoaccept:false, properties:{product:'qdp'}});
    this.downstream = rhea.create_container({container_id:name, autoaccept:false, properties:{product:'qdp'}});
    bind(this.upstream, this, 'receiver_open', 'on_client_receiver_open');
    bind(this.upstream, this, 'sender_open', 'on_client_sender_open');
    bind(this.upstream, this, 'connection_open', 'on_client_connection_open');

    bind(this.upstream, this, 'receiver_close');
    bind(this.upstream, this, 'sender_close');
    bind(this.upstream, this, 'connection_close');
    bind(this.upstream, this, 'disconnected');
    bind(this.upstream, this, 'message');
    bind(this.upstream, this, 'accepted');
    bind(this.upstream, this, 'rejected');
    bind(this.upstream, this, 'released');
    bind(this.upstream, this, 'modified');

    bind(this.downstream, this, 'receiver_close');
    bind(this.downstream, this, 'sender_close');
    bind(this.downstream, this, 'connection_close');
    bind(this.downstream, this, 'disconnected');
    bind(this.downstream, this, 'message');
    bind(this.downstream, this, 'accepted');
    bind(this.downstream, this, 'rejected');
    bind(this.downstream, this, 'released');
    bind(this.downstream, this, 'modified');
};

RelayServer.prototype.listen = function (options) {
    return this.upstream.listen(options);
};

RelayServer.prototype.on_client_receiver_open = function (context) {
    context.receiver.set_target(context.receiver.target);
    link(context.receiver, context.connection.relay.open_sender({target:copy(context.receiver.target, target_fields)}));
};

RelayServer.prototype.on_client_sender_open = function (context) {
    let source = get_relay_source(context.sender.source);
    context.sender.set_source(source);
    link(context.sender, context.connection.relay.open_receiver({source:source}));
};

RelayServer.prototype.on_client_connection_open = function (context) {
    link(context.connection, this.downstream.connect(this.downstream_details));
};

RelayServer.prototype.on_receiver_close = function (context) {
    close_link(context.receiver);
};

RelayServer.prototype.on_sender_close = function (context) {
    close_link(context.sender);
};

RelayServer.prototype.on_connection_close = function (context) {
    close_connection(context.connection);
};

RelayServer.prototype.on_disconnected = function (context) {
    if (context.connection.relay) {
        close_connection(context.connection, {condition:'amqp:connection:forced', description:'disconnected'});
    }
};

RelayServer.prototype.start_span = function (context) {
    if (this.tracer) {
        let address = context.message.to || context.receiver.target.address;
        let container = context.connection.container_id;
        let parentSpanContext = this.tracer.extract(opentracing.FORMAT_HTTP_HEADERS, context.message.message_annotations);
        let span = this.tracer.startSpan(container + '-to-' + address, { childOf: parentSpanContext });
        span.setTag(opentracing.Tags.COMPONENT, 'qdr-proxy');
        span.setTag(opentracing.Tags.SPAN_KIND, opentracing.Tags.SPAN_KIND.CLIENT);

        context.message.message_annotations = {};
        this.tracer.inject(span, opentracing.FORMAT_HTTP_HEADERS, context.message.message_annotations);
        common.remove_nulls(context.message.message_annotations);

        return span;
    }
};

RelayServer.prototype.finish_span = function (context, tags) {
    let span = context.delivery.relay.span;
    if (span) {
        for (let name in tags) {
            span.setTag(name, tags[name])
        }
        span.finish();
    }
};

RelayServer.prototype.on_message = function (context) {
    context.delivery.span = this.start_span(context);
    link(context.delivery, context.receiver.relay.send(context.message));
};

RelayServer.prototype.on_accepted = function (context) {
    this.finish_span(context, {'outcome': 'accepted'});
    context.delivery.relay.accept();
    unlink(context.delivery);
};

RelayServer.prototype.on_released = function (context) {
    this.finish_span(context, {'outcome': 'released'});
    context.delivery.relay.release();
    unlink(context.delivery);
};

RelayServer.prototype.on_modified = function (context) {
    this.finish_span(context, {'outcome': 'modified'});
    context.delivery.relay.modified(context.delivery.remote_state);
    unlink(context.delivery);
};

RelayServer.prototype.on_rejected = function (context) {
    this.finish_span(context, {'outcome': 'rejected', 'error-condition':context.delivery.remote_state.error.condition});
    context.delivery.relay.reject(context.delivery.remote_state.error);
    unlink(context.delivery);
};

module.exports.server = function (name, downstream_details, tracer) {
    return new RelayServer(name, downstream_details, tracer);
};
