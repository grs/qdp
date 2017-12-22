FROM enmasseproject/nodejs-base:6

RUN mkdir -p /opt/app-root/src/
WORKDIR /opt/app-root/src/

ADD package.json /opt/app-root/src/
RUN npm install
COPY . .

EXPOSE 15001

CMD ["node", "/opt/app-root/src/bin/proxy.js"]
