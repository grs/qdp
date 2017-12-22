Install enmasse 0.14.0:

~/releases/enmasse/enmasse-0.14.0/deploy-openshift.sh

Install jaeger collector and query service:

oc process -f https://raw.githubusercontent.com/jaegertracing/jaeger-openshift/master/all-in-one/jaeger-all-in-one-template.yml | oc create -f -

Allow pods to run as privileged (required for the istio init approach):

oc login -u system:admin
oc adm policy add-scc-to-user privileged -z default -n $(oc project -q)

Inject sidecars into istio bookinfo sample app and apply:

oc apply -f <(curl https://raw.githubusercontent.com/istio/istio/release-0.1/samples/apps/bookinfo/bookinfo.yaml | QDP_DOMAIN=<domain-suffix> node ./bin/inject.js)

Then add a route for the productpage service of the form productpag<domain-suffix>. That route then provides access to the app.