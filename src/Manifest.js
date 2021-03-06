//@flow
const S3Store = require("./S3Store");
const sortedIndex = require("lodash").sortedIndex;
const sortedUniq = require("lodash").sortedUniq;
const isEqual = require("lodash").isEqual;
const delay = require("./utils").delay;
const LRUCache = require("lru-cache");

class Manifest {
  store: S3Store;
  dates: string[];
  promise: Promise<any>;
  savePromise: ?Promise<any>;
  saveAgain: boolean;
  dateCache: any;

  constructor({ store }: { store: S3Store }) {
    this.store = store;
    this.dates = [];
    this.saveAgain = false;
    this.dateCache = LRUCache({ max: 5, maxAge: 120 * 1000 });
  }

  get client(): any {
    return this.store.client;
  }
  get bucket(): string {
    return this.store.bucket;
  }
  get prefix(): string {
    return this.store.prefix;
  }

  get key() {
    return `${this.store.prefix}manifest.json`;
  }

  async getDatesBefore(date: string, limit: number): Promise<string[]> {
    await this.load();
    const index = sortedIndex(this.dates, date);
    return this.dates.slice(Math.max(0, index - limit), index);
  }

  async load(): Promise<void> {
    if (this.dateCache.get("current")) {
      return;
    }
    if (!this.promise) {
      let updated = false;
      this.promise = Promise.race([
        (async () => {
          let data;
          try {
            data = await this.loadFromBlob();
          } catch (err) {
            return;
          }
          // prefer loading from list to loading from blob
          if (!updated) {
            this.loadJSON(data);
            updated = true;
          }
        })(),
        (async () => {
          await delay(1000);
          if (updated) return;
          let dates;
          try {
            dates = await this.loadFromList();
          } catch (err) {
            return;
          }
          const datesChanged = this.addDates(dates);
          if (datesChanged) {
            this.save();
          }
        })()
      ]);
    }
    await this.promise;
    this.dateCache.set("current", true);
  }

  async loadFromBlob() {
    const response = await this.client
      .getObject({
        Bucket: this.bucket,
        Key: this.key
      })
      .promise();
    return JSON.parse(response.Body.toString("utf8"));
  }

  async loadFromList(): Promise<string[]> {
    const response: {
      Contents: { Key: string, ETag: string }[]
    } = await this.client
      .listObjectsV2({
        Bucket: this.bucket,
        MaxKeys: 1000,
        Prefix: `${this.prefix}views/`,
        Delimiter: "/"
      })
      .promise();
    return response.Contents.map(e => {
      const match = e.Key.match(/(\d\d\d\d-\d\d-\d\d)[^\/]*$/);
      const isoDate = (match && match[1]) || "";
      return isoDate;
    }).filter(s => s.length === 10);
  }

  async save() {
    if (this.savePromise) {
      this.saveAgain = true;
      await this.savePromise;
      if (this.saveAgain) {
        this.saveAgain = false;
        this.savePromise = this.saveToBlob();
        await this.savePromise;
        this.savePromise = undefined;
      }
      return;
    }

    this.savePromise = this.saveToBlob();
    await this.savePromise;
    this.savePromise = undefined;
  }

  async saveToBlob(): Promise<void> {
    await this.client
      .putObject({
        Body: JSON.stringify(this),
        ContentType: "application/json",
        Bucket: this.bucket,
        Key: this.key
      })
      .promise();
  }

  async addDate(isoDate: string, loaded: boolean = false) {
    const index = sortedIndex(this.dates, isoDate);
    if (this.dates[index] !== isoDate) {
      if (!loaded) {
        this.dateCache.reset();
        await this.load();
        return await this.addDate(isoDate, true);
      }
      this.dates.splice(index, 0, isoDate);
      await this.save();
    }
  }

  addDates(dates: string[]) {
    let combinedDates = this.dates.concat(dates);
    combinedDates.sort();
    combinedDates = sortedUniq(combinedDates);
    const datesChanged = !isEqual(this.dates, combinedDates);
    if (datesChanged) {
      this.dates = combinedDates;
    }
    return datesChanged;
  }

  loadJSON(data: { dates: string[] }): void {
    const dates: string[] = data.dates;
    this.addDates(dates);
  }

  toJSON(): { dates: string[] } {
    return {
      dates: this.dates
    };
  }
}

module.exports = Manifest;
