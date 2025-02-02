import * as Browser from "./types";
import * as fs from "fs";
import * as path from "path";
import { filter, merge, filterProperties, exposesTo, getEmptyWebIDL, resolveExposure, followTypeReferences, markAsDeprecated, mapToArray } from "./helpers";
import { Flavor, emitWebIDl } from "./emitter";
import { convert } from "./widlprocess";

function emitDomWorker(webidl: Browser.WebIdl, forceKnownWorkerTypes: Set<string>, tsWorkerOutput: string) {
    const worker = getEmptyWebIDL();
    if (webidl.interfaces) worker.interfaces!.interface = filter(webidl.interfaces.interface, o => exposesTo(o, "Worker"));

    const knownWorkerTypes = followTypeReferences(webidl, worker.interfaces!.interface);
    forceKnownWorkerTypes.forEach(t => knownWorkerTypes.add(t));
    const isKnownWorkerName = (o: { name: string }) => knownWorkerTypes.has(o.name);

    if (webidl["callback-functions"]) worker["callback-functions"]!["callback-function"] = filterProperties(webidl["callback-functions"]!["callback-function"], isKnownWorkerName);
    if (webidl["callback-interfaces"]) worker["callback-interfaces"]!.interface = filterProperties(webidl["callback-interfaces"]!.interface, isKnownWorkerName);
    if (webidl.dictionaries) worker.dictionaries!.dictionary = filterProperties(webidl.dictionaries.dictionary, isKnownWorkerName);
    if (webidl.enums) worker.enums!.enum = filterProperties(webidl.enums.enum, isKnownWorkerName);
    if (webidl.mixins) worker.mixins!.mixin = filterProperties(webidl.mixins.mixin, isKnownWorkerName);
    if (webidl.typedefs) worker.typedefs!.typedef = webidl.typedefs.typedef.filter(t => knownWorkerTypes.has(t["new-type"]));

    const result = emitWebIDl(worker, Flavor.Worker);
    fs.writeFileSync(tsWorkerOutput, result);
    return;
}

function emitDomWeb(webidl: Browser.WebIdl, tsWebOutput: string) {
    const browser = filter(webidl, o => exposesTo(o, "Window"));

    const result = emitWebIDl(browser, Flavor.Web);
    fs.writeFileSync(tsWebOutput, result);
    return;
}

function emitES6DomIterators(webidl: Browser.WebIdl, tsWebIteratorsOutput: string) {
    fs.writeFileSync(tsWebIteratorsOutput, emitWebIDl(webidl, Flavor.ES6Iterators));
}

function emitDom() {
    const __SOURCE_DIRECTORY__ = __dirname;
    const inputFolder = path.join(__SOURCE_DIRECTORY__, "../", "inputfiles");
    const outputFolder = path.join(__SOURCE_DIRECTORY__, "../", "generated");

    // Create output folder
    if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder);
    }

    const tsWebOutput = path.join(outputFolder, "dom.generated.d.ts");
    const tsWebIteratorsOutput = path.join(outputFolder, "dom.iterable.generated.d.ts");
    const tsWorkerOutput = path.join(outputFolder, "webworker.generated.d.ts");


    const overriddenItems = require(path.join(inputFolder, "overridingTypes.json"));
    const addedItems = require(path.join(inputFolder, "addedTypes.json"));
    const comments = require(path.join(inputFolder, "comments.json"));
    const removedItems = require(path.join(inputFolder, "removedTypes.json"));
    const idlSources = require(path.join(inputFolder, "idlSources.json"));
    const widlStandardTypes = idlSources.map(convertWidl);

    function convertWidl({ title, deprecated }: { title: string; deprecated?: boolean }) {
        const filename = title + ".widl";
        const idl: string = fs.readFileSync(path.join(inputFolder, "idl", filename), { encoding: "utf-8" });
        const commentsMapFilePath = path.join(inputFolder, "idl", title + ".commentmap.json");
        const commentsMap: Record<string, string> = fs.existsSync(commentsMapFilePath) ? require(commentsMapFilePath) : {};
        const result = convert(idl, commentsMap);
        if (deprecated) {
            mapToArray(result.browser.interfaces!.interface).forEach(markAsDeprecated);
            result.partialInterfaces.forEach(markAsDeprecated);
        }
        return result;
    }

    /// Load the input file
    let webidl: Browser.WebIdl = require(path.join(inputFolder, "browser.webidl.preprocessed.json"));

    const knownWorkerTypes = new Set<string>(require(path.join(inputFolder, "knownWorkerTypes.json")));

    for (const w of widlStandardTypes) {
        webidl = merge(webidl, w.browser, true);
    }
    for (const w of widlStandardTypes) {
        for (const partial of w.partialInterfaces) {
            // Fallback to mixins before every spec migrates to `partial interface mixin`.
            const base = webidl.interfaces!.interface[partial.name] || webidl.mixins!.mixin[partial.name];
            if (base) {
                if (base.exposed) resolveExposure(partial, base.exposed);
                merge(base.constants, partial.constants, true);
                merge(base.methods, partial.methods, true);
                merge(base.properties, partial.properties, true);
            }
        }
        for (const partial of w.partialDictionaries) {
            const base = webidl.dictionaries!.dictionary[partial.name];
            if (base) {
                merge(base.members, partial.members, true);
            }
        }
        for (const include of w.includes) {
            const target = webidl.interfaces!.interface[include.target];
            if (target) {
                if (target.implements) {
                    target.implements.push(include.includes);
                }
                else {
                    target.implements = [include.includes];
                }
            }
        }
    }
    webidl = prune(webidl, removedItems);
    webidl = merge(webidl, addedItems);
    webidl = merge(webidl, overriddenItems);
    webidl = merge(webidl, comments);
    for (const name in webidl.interfaces!.interface) {
        const i = webidl.interfaces!.interface[name];
        if (i["override-exposed"]) {
            resolveExposure(i, i["override-exposed"]!, true);
        }
    }

    emitDomWeb(webidl, tsWebOutput);
    emitDomWorker(webidl, knownWorkerTypes, tsWorkerOutput);
    emitES6DomIterators(webidl, tsWebIteratorsOutput);

    function prune(obj: Browser.WebIdl, template: Partial<Browser.WebIdl>): Browser.WebIdl {
        const result = filterByNull(obj, template);
        if (obj.typedefs) result.typedefs!.typedef = obj.typedefs.typedef.filter(t => !(template.typedefs && template.typedefs.typedef.find(o => o["new-type"] === t["new-type"])));

        return result;

        function filterByNull(obj: any, template: any) {
            if (!template) return obj;
            const filtered: any = {};
            for (const k in obj) {
                if (template.hasOwnProperty(k) && !Array.isArray(template[k])) {
                    if (template[k] !== null) {
                        filtered[k] = filterByNull(obj[k], template[k]);
                    }
                }
                else {
                    filtered[k] = obj[k];
                }
            }
            return filtered;
        }
    }
}

emitDom();
