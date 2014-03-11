var colors = require('colors'),
	util = require('util'),
	http = require('http'),
	mongodb = require('mongodb'),
    events = require('events');
    url = require('url');

var Cache = function(options) {
	//variable declarations
	var cache;
	var self = this;
	var maxResources = 20;

	this.Cache = function(){
		this._init();
	}

	this.startMongo = function(){
		var address = '127.0.0.1';
  	var port = 27017;
  	var server = new mongodb.Server(address, port, {});
  	var db = new mongodb.Db('CacheDB', server, {safe: true});
  	db.open(function (error, client){
    	if(error)throw error;
    	self.cache = new mongodb.Collection(client, 'cache');
    	console.log('Started MongoDB On'.green,address.yellow+':'+port);
    	self.cache.remove(function(err, rows){
        //do nothing
      });
    	//launch event when the database is started
    	self.emit('started');
  	});
	}

	//search and delete a resource using LRU, TODO: implement other methods
	this.replaceAlgorithm = function(){
		console.log('LRU'.red);
		var options = {
			"fields": ['_id','url'],
			"sort": "recentlyUse",
			"limit": 1
		}
		//find(condition,options,callback) | find(condition,options).toArray(callback)
		self.cache.find({},options).toArray(function(err, docs){
			console.log(docs[0]['_id']);
			self.deleteResource(docs[0]['_id']);
		});
	}

	//Fields:
	//url - resource - headers - insertDate - revalidationDate - recentlyUse - hits

	//save a new resource in the cache but first executes the replace algorithm
	this.newResource = function(resourceUrl,resource,headers){
		self.cache.count(function(err, count) {
    	if(!err)console.log('Cache Size:'.blue,count);
      	if(count >= maxResources){
					//delete one resource with the replace algorithm
					self.replaceAlgorithm();
			  }
    });
    var date = new Date();
		//insert the new resource
		self.cache.insert({url:resourceUrl, resource:new mongodb.Binary(resource), headers:headers, insertDate:date, revalidationDate:date, recentlyUse:date, hits:0},null, function(err, doc){
  		if(err)console.log('ERROR INSERTING NEW RESOURCE: '.red,err);
		});
		return true;
	}

	//deletes a resource in the database
	this.deleteResource = function(id){
		self.cache.remove({_id:id},function(err,result){
			if(err)console.log('ERROR DELETING RESOURCE: '.red,err);
		});
	}

	this.searchResource = function(resourceUrl,cbSR){
		//var sr = this;
		//sr.cbSR = cbSR;
		console.log('searching'.magenta,resourceUrl);
		var e = new events.EventEmitter();

		process.nextTick(function(){
			//self.cache.find({url:resourceUrl}).toArray(function(err, docs){
      self.cache.findOne({url:resourceUrl},function(errv, doc){
    		console.log('end search'.magenta,resourceUrl);
    		if(doc){
					self.revalidateResource(doc,function(err,resource){
						if(!err){
							e.emit('found', resource);
						}else{
							e.emit('notFound');
						}
					});
        }else{
        		e.emit('notFound');
        }
      });
    })
		return cbSR(null,e);
	}

	//updates a resource in the database
	this.updateResource = function(resource){
		self.cache.update(resource,{safe:true},function(err,result){
			if(err)console.log('ERROR UPDATING RESOURCE: '.red,err);
		});
	}

	this.revalidateResource = function(resource,cbRR){
		process.nextTick(function(){

			var returnResource = function(){
				resource['hits'] = resource['hits']+1;
				resource['recentlyUse'] = actualDate;
				//console.log(JSON.stringify(resource));
				self.updateResource(resource);
				return cbRR(null,resource);
			};

			//var rr = this;
			//rr.cbRR = cbRR;
			var actualDate = new Date();
			var revalidate = true;
			//verify expires or max-age header
			var cachecontrol = false;

			if(resource['headers']['cache-control']){
				var maxage = self.getCacheControlFieldValue(resource['headers']['cache-control'],'max-age');
				if(maxage){
					//seconds
					var maxageDate = new Date(resource['revalidationDate']);
					maxageDate.setSeconds(date.getSeconds() + maxage);
					if(maxageDate<=actualDate){
						revalidate = false;
						console.log('pass maxage validation');
						returnResource();
					}
				}
			}

			if(resource['headers']['expires']){
				var expires = new Date(resource['headers']['expires']);
				if(expires>actualDate){
					revalidate = false;
					console.log('pass expires validation');
					returnResource();
				}
			}

			if(revalidate){
				//sends a request to revalidate the resource
				console.log(resource['url'].yellow);
				var options = {
			    host: url.parse('http://'+resource['url']).host,
			    port: 80,
			    path: url.parse('http://'+resource['url']).path
				};

				//conditional request
				if(resource['headers']['last-modified']){
					options.headers = {'if-modified-since':resource['headers']['last-modified']};
				}else{
					options.headers = {'if-modified-since':new Date()};
				}
				if(resource['headers']['etag']){
					options.headers = {'if-none-match':resource['headers']['etag']};
				}

				var req = http.request(options, function(res){
					console.log('REVALIDATION STATUS: '.rainbow,res.statusCode);
					resource['headers'] = res.headers;
					resource['revalidationDate'] = actualDate;
					if(res.statusCode==304){
						//not-modified
						console.log('resource not modified');
						returnResource();
					}
					if(res.statusCode==200){
						//the resource changed
						var chunks = [];
					    res.on('data', function (chunk) {
					    	chunks.push(chunk);
					    });
						res.on('end', function (){
							resource['resource'] = new mongodb.Binary(Buffer.concat(chunks));
							console.log('resource updated');
							returnResource();
		      	});
					}
					req.on('error', function(e) {
						return cbRR('Error: '+e.message);
				    console.log("ERROR REQUESTING REVALIDATION: ".red, e.message);
				  });
				});
				req.end();
			}
		})
	}

	this.getCacheControlFieldValue = function(header,field){
		var cachecontrol = header.split(' ');
		var tmp;
		for(option in cachecontrol){
			tmp = cachecontrol[option].indexOf(field);
			if(tmp!=-1){
				field += '=';
				return cachecontrol[option].replace(field,'');
			}
		}
		return false;
	}
}

util.inherits(Cache, events.EventEmitter);

var createCache = function(options) {
  return new Cache(options);
};

exports.Cache = Cache;
exports.createCache = createCache;