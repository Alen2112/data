'use strict';

const version = require('@ember-data/private-build-infra/src/create-version-module');

module.exports = {
  name: require('./package').name,

  treeForAddon() {
    let tree = version();
    return this._super.treeForAddon.call(this, tree);
  },
};