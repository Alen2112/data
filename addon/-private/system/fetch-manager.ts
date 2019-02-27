import { RecordIdentifier, identifierFor } from "./record-identifier";
import { default as RSVP, Promise } from 'rsvp';
import { DEBUG } from '@glimmer/env';
import { run as emberRunLoop } from '@ember/runloop';
import Adapter from "@ember/test/adapter";
import { AdapterCache } from "./adapter-cache";
import { assert, deprecate, warn, inspect } from '@ember/debug';

import {
  _find,
  _findMany,
  _findHasMany,
  _findBelongsTo,
  _findAll,
  _query,
  _queryRecord,
} from './store/finders';

const emberRun = emberRunLoop.backburner;

interface PendingFetchItem {
  identifier: RecordIdentifier,
  resolver: RSVP.Deferred<any>,
  options: any,
  trace?: any
}

export default class FetchManager {
  _pendingFetch: Map<string, PendingFetchItem[]>;
  isDestroyed: boolean;
  _adapterCache: AdapterCache;

  constructor(adapterCache: AdapterCache) {
    // used to keep track of all the find requests that need to be coalesced
    this._pendingFetch = new Map();
    this._adapterCache = adapterCache;
  }

  scheduleFetch(identifier: RecordIdentifier, options: any, shouldTrace: boolean): Promise<any> {
    /*
    if (internalModel._promiseProxy) {
        return internalModel._promiseProxy;
    }
    */

    let id = identifier.id;
    let modelName = identifier.type;

    let resolver = RSVP.defer(`Fetching ${modelName}' with id: ${id}`);
    let pendingFetchItem: PendingFetchItem = {
      identifier,
      resolver,
      options,
    };

    if (DEBUG) {
      if (shouldTrace) {
        let trace;

        try {
          throw new Error(`Trace Origin for scheduled fetch for ${modelName}:${id}.`);
        } catch (e) {
          trace = e;
        }

        // enable folks to discover the origin of this findRecord call when
        // debugging. Ideally we would have a tracked queue for requests with
        // labels or local IDs that could be used to merge this trace with
        // the trace made available when we detect an async leak
        pendingFetchItem.trace = trace;
      }
    }

    let promise = resolver.promise;

    //internalModel.loadingData(promise);

    if (this._pendingFetch.size === 0) {
      emberRun.schedule('actions', this, this.flushAllPendingFetches);
    }

    let fetches = this._pendingFetch;

    if (!fetches.has(modelName)) {
      fetches.set(modelName, []);
    }

    (fetches.get(modelName) as PendingFetchItem[]).push(pendingFetchItem);

    return promise;
  }

  _fetchRecord(fetchItem: PendingFetchItem) {

    let identifier = fetchItem.identifier;
    let modelName = identifier.type;
    let adapter = this._adapterCache.adapterFor(modelName);

    assert(`You tried to find a record but you have no adapter (for ${modelName})`, adapter);
    assert(
      `You tried to find a record but your adapter (for ${modelName}) does not implement 'findRecord'`,
      typeof adapter.findRecord === 'function'
    );

    let recordFetch =  _find(adapter, this, modelName, identifier.id, internalModel, fetchItem.options);
    fetchItem.resolver.resolve(recordFetch);
  }


  /*
  handleFoundRecords(foundInternalModels, expectedInternalModels) {
    // resolve found records
    let found = Object.create(null);
    for (let i = 0, l = foundInternalModels.length; i < l; i++) {
      let internalModel = foundInternalModels[i];
      let pair = seeking[internalModel.id];
      found[internalModel.id] = internalModel;

      if (pair) {
        let resolver = pair.resolver;
        resolver.resolve(internalModel);
      }
    }

    // reject missing records
    let missingInternalModels: any = [];

    for (let i = 0, l = expectedInternalModels.length; i < l; i++) {
      let internalModel = expectedInternalModels[i];

      if (!found[internalModel.id]) {
        missingInternalModels.push(internalModel);
      }
    }

    if (missingInternalModels.length) {
      warn(
        'Ember Data expected to find records with the following ids in the adapter response but they were missing: [ "' +
        missingInternalModels.map(r => r.id).join('", "') +
        '" ]',
        false,
        {
          id: 'ds.store.missing-records-from-adapter',
        }
      );
      this.rejectInternalModels(missingInternalModels);
    }
  }

  rejectInternalModels(internalModels, error?) {
    for (let i = 0, l = internalModels.length; i < l; i++) {
      let internalModel = internalModels[i];
      let pair = seeking[internalModel.id];

      if (pair) {
        pair.resolver.reject(
          error ||
          new Error(
            `Expected: '${internalModel}' to be present in the adapter provided payload, but it was not found.`
          )
        );
      }
    }
  }
  */

  _flushPendingFetchForType(pendingFetchItems: PendingFetchItem[], modelName: string) {
    let store = this;
    let adapter = this._adapterCache.adapterFor(modelName);
    let shouldCoalesce = !!adapter.findMany && adapter.coalesceFindRequests;
    let totalItems = pendingFetchItems.length;
    let identifiers = new Array(totalItems);
    let seeking: { [id: string]: PendingFetchItem } = Object.create(null);

    let optionsMap = new WeakMap();

    for (let i = 0; i < totalItems; i++) {
      let pendingItem = pendingFetchItems[i];
      let identifier = pendingItem.identifier;
      identifiers[i] = identifier;
      optionsMap.set(identifier, pendingItem.options);
      seeking[(identifier.id as string)] = pendingItem;
    }

    shouldCoalesce = false;

    if (shouldCoalesce) {
      /*
      // TODO: Improve records => snapshots => records => snapshots
      //
      // We want to provide records to all store methods and snapshots to all
      // adapter methods. To make sure we're doing that we're providing an array
      // of snapshots to adapter.groupRecordsForFindMany(), which in turn will
      // return grouped snapshots instead of grouped records.
      //
      // But since the _findMany() finder is a store method we need to get the
      // records from the grouped snapshots even though the _findMany() finder
      // will once again convert the records to snapshots for adapter.findMany()
      let snapshots = new Array(totalItems);
      for (let i = 0; i < totalItems; i++) {
        snapshots[i] = internalModels[i].createSnapshot(optionsMap.get(internalModel));
      }

      let groups = adapter.groupRecordsForFindMany(this, snapshots);

      for (var i = 0, l = groups.length; i < l; i++) {
        var group = groups[i];
        var totalInGroup = groups[i].length;
        var ids = new Array(totalInGroup);
        var groupedInternalModels = new Array(totalInGroup);

        for (var j = 0; j < totalInGroup; j++) {
          var internalModel = group[j]._internalModel;

          groupedInternalModels[j] = internalModel;
          ids[j] = internalModel.id;
        }

        if (totalInGroup > 1) {
          (function (groupedInternalModels) {
            _findMany(adapter, store, modelName, ids, groupedInternalModels, optionsMap)
              .then((foundInternalModels) => {
                this.handleFoundRecords(foundInternalModels, groupedInternalModels);
              })
              .catch((error) => {
                this.rejectInternalModels(groupedInternalModels, error);
              });
          })(groupedInternalModels);
        } else if (ids.length === 1) {
          var pair = seeking[groupedInternalModels[0].id];
          this._fetchRecord(pair);
        } else {
          assert(
            "You cannot return an empty array from adapter's method groupRecordsForFindMany",
            false
          );
        }
      }
      */
    } else {
      for (let i = 0; i < totalItems; i++) {
        this._fetchRecord(pendingFetchItems[i]);
      }
    }
  }

  flushAllPendingFetches() {
    if (this.isDestroyed) {
      return;
    }

    this._pendingFetch.forEach(this._flushPendingFetchForType, this);
    this._pendingFetch.clear();
  }

  destroy() {
    this.isDestroyed = true;
  }
}