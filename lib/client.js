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

var amqp = require('rhea');

function bind(client, event) {
    client.connection.on(event, client['on_' + event].bind(client));
}

function Client (options) {
    this.requests = [];
    this.handlers = {};
    this.connection = amqp.connect(options);
    this.sender = this.connection.open_sender({target:{}});
    this.receiver = this.connection.open_receiver({source:{dynamic:true}});
    this.counter = 1;
    bind(this, 'message');
    bind(this, 'receiver_open');
    bind(this, 'sendable');
    bind(this, 'disconnected');
};

Client.prototype.on_message = function (context) {
    var handler = this.handlers[context.message.correlation_id];
    if (handler) {
        delete this.handlers[context.message.correlation_id];
        handler.resolve(context.message);
    }
};

Client.prototype.on_receiver_open = function (context) {
    this.address = context.receiver.source.address;
    this.send_pending_requests();
};

Client.prototype.on_sendable = function (context) {
    this.send_pending_requests();
};

Client.prototype.send = function (message) {
    message.reply_to = this.address;
    this.sender.send(message);
};

Client.prototype.send_pending_requests = function (context) {
    while (this.ready() && this.requests.length > 0) {
        this.send(this.requests.shift());
    }
    return this.requests.length === 0;
};

Client.prototype.request = function (message) {
    message.correlation_id = this.counter++;
    var handlers = this.handlers;
    var promise =  new Promise(function (resolve, reject) {
        handlers[message.correlation_id] = {resolve:resolve, reject:reject};
    });
    if (this.ready() && this.send_pending_requests()) {
        this.send(message);
    } else {
        this.requests.push(message);
    }
    return promise;
};

Client.prototype.ready = function (details) {
    return this.address !== undefined && this.sender.sendable();
};

Client.prototype.close = function () {
    this.connection.close();
};

Client.prototype.on_disconnected = function (context) {
    this.address = undefined;
    for (var key in this.handlers) {
        this.handlers[key].reject('aborted');
    }
    this.handlers = {};
};

module.exports.connect = function (options) {
    return new Client(options);
};
