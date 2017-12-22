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

var util = require('util');
var yaml = require('js-yaml');

function jaeger_sidecar () {
    return {
        image: 'jaegertracing/jaeger-agent',
        name: 'jaeger-agent',
        ports: [
            {
                containerPort: 5775,
                protocol: 'UDP'
            },
            {
                containerPort: 5778
            },
            {
                containerPort: 6831,
                protocol: 'UDP'
            },
            {
                containerPort: 6832,
                protocol: 'UDP'
            }
        ],
        securityContext: {
            runAsUser: 1337
        },
        command: [
            '/go/bin/agent-linux',
            '--collector.host-port=jaeger-collector:14267'
        ]
    };
}

function istio_init() {
    return {
        name: 'istio-init',
        image: 'docker.io/istio/proxy_init:0.2.6',
        imagePullPolicy: 'IfNotPresent',
        securityContext: {
            capabilities: {
                add: ['NET_ADMIN']
            }
        },
        args: [
            '-p',
            '15001',
            '-u',
            '1337'
        ]

    };
}

function qdp_sidecar(args) {
    return {
        image: 'gordons/qdr-proxy:latest',
        name: 'qdr-proxy',
        ports: [
            {
                containerPort: 15001
            }
        ],
        securityContext: {
            runAsUser: 1337
        },
        command: ['node', '/opt/app-root/src/bin/proxy.js'].concat(args)
    };
}

function is_deployment_in_service(deployment, service) {
    var labels = deployment.spec.template.metadata.labels;
    var selector = service.spec.selector;
    for (var key in selector) {
        if (labels[key] !== selector[key]) {
            return false;
        }
    }
    return selector !== undefined;
}

function is_relevant_port(port) {
    return port.name.indexOf('http') === 0 || port.name.indexOf('grpc') === 0;
}

function relevant_port(service) {
    return service.spec.ports.filter(is_relevant_port)[0];
}

function is_relevant_service(deployment, service) {
    return is_deployment_in_service(deployment, service) && relevant_port(service);
}

function relevant_services(deployment, services) {
    return services.filter(is_relevant_service.bind(null, deployment));
}

function is_service(object) {
    return object && object.kind === 'Service';
}

function is_deployment(object) {
    return object && object.kind === 'Deployment';
}

function extract_objects(input, filter) {
    if (util.isArray(input)) {
        return input.filter(filter);
    } else if (filter(input)) {
        return [input];
    } else {
        return [];
    }
}

function extract_services(input) {
    return extract_objects(input, is_service);
}

function extract_deployments(input) {
    return extract_objects(input, is_deployment);
}

function inject(deployment, services) {
    var containers = deployment.spec.template.spec.containers;
    containers.push(jaeger_sidecar());
    if (deployment.spec.template.spec.initContainers === undefined) {
        deployment.spec.template.spec.initContainers = [];
    }
    deployment.spec.template.spec.initContainers.push(istio_init());
    var args = services.map(function (service) {
        var port = relevant_port(service) || {};
        return util.format('%s=localhost:%s', service.metadata.name, port.targetPort || port.port);
    });
    var qdp = qdp_sidecar(args);
    var env = [];
    if (process.env.QDP_DOMAIN) {
        env.push({name: 'QDP_DOMAIN', value:process.env.QDP_DOMAIN});
    }
    console.log('metadata: %j', deployment.spec.template.metadata);
    env.push({name: 'SERVICE_NAME', value:deployment.spec.template.metadata.labels.app || deployment.spec.template.metadata.labels.name || deployment.spec.template.metadata.name});
    if (deployment.spec.template.metadata.labels.version) {
        env.push({name: 'SERVICE_VERSION', value:deployment.spec.template.metadata.labels.version});
    }
    qdp.env = env;
    containers.push(qdp);
}

var input = '';
process.stdin.on('data', function (chunk) {
    input += chunk;
});
process.stdin.on('end', function () {
    var object = yaml.safeLoadAll(input);
    var services = extract_services(object);
    var deployments = extract_deployments(object);
    deployments.forEach(function (deployment) {
        inject(deployment, relevant_services(deployment, services));
    });
    if (util.isArray(object)) {
        object.forEach(function (o) {
            if (o) {
                console.log(yaml.safeDump(o));
                console.log('---');
            }
        });
    } else {
        console.log(yaml.safeDump(object));
    }
});

