// Copyright 2016 Markus D. Herrmann, University of Zurich and Robin Hafen
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// interface SerializedViewer extends Serialized<Viewer> {
//     experiment: SerializedExperiment;
//     viewport: SerializedViewport;
// }
class Viewer {
    id: string;

    experiment: Experiment;
    viewport: Viewport;
    _currentResult: ToolResult = null;
    savedResults: ToolResult[] = [];

    // TODO: don't use zero as default but middle of z-stack
    private _currentTpoint = 0;
    private _currentZplane = 0;

    private _element: JQuery = null;

    private _$http: ng.IHttpService;
    private _$q: ng.IQService;
    private _$interval: ng.IIntervalService;

    mapObjectSelectionHandler: MapObjectSelectionHandler;
    tools: ng.IPromise<Tool[]>;
    channels: Channel[] = [];
    mapobjectTypes: MapobjectType[] = [];
    isSubmissionHandled: any = {};


    // TODO: A viewer should mayble be creatable without an experiment.
    // The initialization process of loading an experiment would be done by a
    // separate function.
    constructor(experiment: Experiment) {

        this._$http = $injector.get<ng.IHttpService>('$http');
        this._$q = $injector.get<ng.IQService>('$q');
        this._$interval = $injector.get<ng.IIntervalService>('$interval');

        this.id = makeUUID();
        this.experiment = experiment;
        this.viewport = new Viewport();

        this.tools = this.getTools();

        console.log('instatiate viewer')
        this.experiment.getChannels()
        .then((channels) => {
            if (channels) {
                this.viewport.initMap(channels[0].layers[0].imageSize)
                channels.forEach((ch) => {
                    // The mapSize attribute is important for SegmentationLayers
                    this.viewport.mapSize = {
                        height: ch.height, width: ch.width
                    };
                    this.channels.push(ch);
                    this.viewport.addLayer(ch);
                });
            }
        })

        this.mapObjectSelectionHandler = new MapObjectSelectionHandler(this);
        this.experiment.getMapobjectTypes()
        .then((mapobjectTypes) => {
            // Subsequently add the selection handler and initialize the layers.
            // TODO: The process of adding the layers could be made nicer.
            // The view should be set independent of 'ChannelLayers' etc.
            if (mapobjectTypes) {
                mapobjectTypes.forEach((t) => {
                    this.mapobjectTypes.push(t);
                    this.mapObjectSelectionHandler.addMapObjectType(t.name);
                    this.mapObjectSelectionHandler.addNewSelection(t.name);
                });
            }
        })

        this._startMonitoringJobs(3000);

        //// DEBUG
        // var segmLayer = new SegmentationLayer('DEBUG_TILE', {
        //     tpoint: 0,
        //     experimentId: this.experiment.id,
        //     zplane: 0,
        //     size: this.viewport.mapSize,
        //     visible: true
        // });
        // segmLayer.strokeColor = Color.RED;
        // segmLayer.fillColor = Color.WHITE.withAlpha(0);
        // this.viewport.addLayer(segmLayer);
    }

    getTools(): ng.IPromise<any> {
        return this._$http.get('/api/tools')
        .then((resp: any) => {
            // console.log(resp)
            return resp.data.data.map((t) => {
                return new Tool(t);
            });
        })
        .catch((resp) => {
            return this._$q.reject(resp.data.error);
        });
    }

    get currentResult() {
        return this._currentResult;
    }

    set currentResult(r: ToolResult) {
        this.deleteCurrentResult();
        this._currentResult = r;
        this._hideAllSavedResults();
    }

    private _hideAllSavedResults() {
        this.savedResults.forEach((r) => {
            r.visible = false;
        });
    }

    private _deleteResult(res: ToolResult) {
        // TODO: Also completely remove the result
        res.visible = false;
    }

    deleteSavedResult(res: ToolResult) {
        var idx = this.savedResults.indexOf(res);
        if (idx > -1) {
            this._deleteResult(res);
            this.savedResults.splice(idx, 1);
        }
    }

    deleteCurrentResult() {
        if (this.currentResult !== null) {
            this._deleteResult(this.currentResult);
            this._currentResult = null;
        }
    }

    saveCurrentResult() {
        this.savedResults.push(this.currentResult);
        this._currentResult = null;
    }

    hasCurrentResult() {
        return this._currentResult !== null;
    }

    get currentTpoint() {
        return this._currentTpoint;
    }

    set currentTpoint(t: number) {
        this.channels.forEach((ch) => {
            ch.setPlane(this._currentZplane, t);
        });
        this._currentTpoint = t;
    }

    get currentZplane() {
        return this._currentZplane;
    }

    set currentZplane(z: number) {
        this.channels.forEach((ch) => {
            ch.setPlane(z, this._currentTpoint);
        });
        this._currentZplane = z;
    }

    destroy() {
        this.element.remove();
    }

    get element(): JQuery {
        if (this._element === null || this._element.length == 0) {
            var $document = $injector.get<ng.IDocumentService>('$document');
            this._element = $document.find('#viewer-'+ this.id);
        }
        return this._element;
    }

    hide() {
        this.element.hide();
    }

    show() {
        this.element.show();
        this.viewport.update();
    }

    /**
     * Handle the result of a successful tool response.
     * @param data The response that was received by the client.
     * This object also contains the tool-specific result object.
     */
    private _handleSuccessfulToolResult(res: SerializedToolResult) {
        // TODO: Send event to Viewer messagebox
        // var sessionUUID = data.session_uuid;
        console.log('ToolService: HANDLE REQUEST.');
        var result = (new ToolResultDAO(this.experiment.id)).fromJSON(res);
        result.attachToViewer(this);
        result.visible = false;
        // session.isRunning = false;
        // session.results.push(result);
        if (this.currentResult !== null) {
            if (result.submissionId > this.currentResult.submissionId) {
                console.log('update current result: ', result)
                this.saveCurrentResult();
                this.currentResult = result;
            } else {
                var submissionIds = this.savedResults.map((res) => {
                    return res.submissionId;
                })
                if (submissionIds.indexOf(result.submissionId) == -1 && result.submissionId != this.currentResult.submissionId) {
                    console.log('save result: ', result)
                    this.savedResults.push(result);
                }
            }
        } else {
            console.log('update current result: ', result)
            this.currentResult = result;
        }
        // TODO: Send event to Viewer messagebox
        console.log('ToolService: DONE.');
    }

    /**
     * Start long-polling the server for a tool result.
     * @param jobId The id of the job processing the tool request.
     * @param session The tool session from which the original request was sent.
     * @type ng.IPromise<any>
     */
    private _startMonitoringJobs(delayMs: number) {
        var promise = this._$interval(() => {
            // Query the server for job statuses
            this._$http.get('/api/experiments/' + this.experiment.id + '/tools/status')
            .then((resp: any) => {
                _(this.savedResults).each((res) => {
                    if (res !== null) {
                        this.isSubmissionHandled[res.submissionId] = true;
                    }
                });
                var jobStati = resp.data.data;
                _(jobStati).each((st) => {
                    if ((st.state == 'TERMINATING' || st.state == 'TERMINATED') && st.exitcode == 0) {
                        if (!this.isSubmissionHandled[st.submission_id]) {
                            this._$http.get('/api/experiments/' + this.experiment.id + '/tools/result?submission_id=' + st.submission_id)
                            .then((resp: any) => {
                                var result = resp.data.data;
                                this._handleSuccessfulToolResult(result);
                            });
                        }
                    }
                });
                if (this.currentResult !== null) {
                    this.currentResult.visible = true;
                }
            });

        }, delayMs);
        return promise;
    }

    /**
     * Send a request to the server-side tool to start a processing job.
     * The server will respond with a JSON object that containts a 'status'
     * property. If this property evaluates to 'ok' then the processing
     * was started successfully and the server should be queried for a tool
     * result by long-polling.
     * @param session The tool session
     * @param payload An object containing information that is understood by
     * the a particular server-side tool.
     * @type ng.IPromise<boolean>
     */
    sendToolRequest(session: ToolSession, payload: any) {
        var url = '/api/experiments/' + this.experiment.id + '/tools/request';
        var $http = $injector.get<ng.IHttpService>('$http');
        var request: ServerToolRequest = {
            session_uuid: session.uuid,
            payload: payload,
            tool_name: session.tool.name
        };
        console.log('ToolService: START REQUEST.');
        return $http.post(url, request).then(
        (resp: any) => {
            // if (resp.data.status == 'ok') {
            //     // this._startMonitoringToolResponseStatus(resp.data.job_id, session);
            //     console.log('Successfully started job server-side.');
            // } else {
            //     console.log('Error: failed to start job server-side.');
            // }
            return true;
        },
        (err) => {
            return false;
        });

    }

    /**
     * The highest zoom level for any layer of this experiment.
     * It is assumed that all layers of an experiment have the same max
     * zoom level.
     * @type number
     */
    get maxZoom(): number {
        return this.channels[0].layers[0].maxZoom;
    }

    /**
     * The highest time point supported by this experiment.
     * @type number
     */
    get maxT(): number {
        if (this.channels) {
            var ts = this.channels.map((ch) => {
                return ch.maxT;
            });
            return Math.max.apply(this, ts);
        } else {
            return 0;
        }
    }

    /**
     * The lowest time point supported by this experiment.
     * @type number
     */
    get minT(): number {
        if (this.channels) {
            var ts = this.channels.map((ch) => {
                return ch.minT;
            });
            return Math.min.apply(this, ts);
        } else {
            return 0;
        }
    }

    /**
     * The highest zplane supported by this experiment.
     * @type number
     */
    get maxZ(): number {
        if (this.channels) {
            var zs = this.channels.map((ch) => {
                return ch.maxZ;
            });
            return Math.max.apply(this, zs);
        } else {
            return 0;
        }
    }

    /**
     * The lowest zplane supported by this experiment.
     * @type number
     */
    get minZ(): number {
        if (this.channels) {
            var zs = this.channels.map((ch) => {
                return ch.minZ;
            });
            return Math.min.apply(this, zs);
        } else {
            return 0;
        }
    }
}